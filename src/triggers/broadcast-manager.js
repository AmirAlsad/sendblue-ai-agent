require('dotenv').config();
const { Queue, Worker } = require('bullmq');
const { v4: uuidv4 } = require('uuid');
const { getClient } = require('../utils/redis-client');
const userAdapter = require('../adapters/user-adapter');
const { enqueueTrigger } = require('./trigger-queue');
const { createLogger } = require('../utils/logger');

const logger = createLogger('broadcast-manager');

const CONFIG = {
  QUEUE_NAME: process.env.BROADCAST_QUEUE_NAME || 'broadcast-distribution',
  RATE_LIMIT: parseInt(process.env.BROADCAST_RATE_LIMIT, 10) || 3, // jobs per second
  RETRY_ATTEMPTS: 2,
  RETRY_DELAY_MS: 5000
};

function getRedisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {})
  };
}

let queue = null;
let worker = null;

function getQueue() {
  if (queue) {
    return queue;
  }

  const connection = getRedisConnection();
  if (!connection) {
    return null;
  }

  try {
    queue = new Queue(CONFIG.QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { age: 86400 }, // Keep completed for 24 hours
        removeOnFail: 100,
        attempts: CONFIG.RETRY_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: CONFIG.RETRY_DELAY_MS
        }
      }
    });

    logger.info({ queueName: CONFIG.QUEUE_NAME }, 'Broadcast queue initialized');
    return queue;
  } catch (error) {
    logger.error({ err: error, queueName: CONFIG.QUEUE_NAME }, 'Failed to initialize broadcast queue');
    return null;
  }
}

async function processBroadcastJob(job) {
  const { broadcastId, userId, message, metadata } = job.data;

  try {
    const trigger = {
      userId,
      message,
      timestamp: new Date().toISOString(),
      metadata: {
        ...metadata,
        broadcastId,
        broadcast: true
      }
    };

    await enqueueTrigger(userId, trigger);

    await updateBroadcastProgress(broadcastId, 'completed');

    return { success: true, userId };

  } catch (error) {
    await updateBroadcastProgress(broadcastId, 'failed');
    throw error;
  }
}

function initializeWorker() {
  if (worker) {
    return worker;
  }

  const connection = getRedisConnection();
  if (!connection) {
    logger.warn('Cannot initialize broadcast worker; Redis not configured');
    return null;
  }

  try {
    worker = new Worker(
      CONFIG.QUEUE_NAME,
      processBroadcastJob,
      {
        connection,
        concurrency: 1, // Process one at a time for rate limiting
        limiter: {
          max: CONFIG.RATE_LIMIT,
          duration: 1000 // 1 second
        }
      }
    );

    worker.on('completed', () => {});

    worker.on('failed', (job, error) => {
      logger.error({ err: error, jobId: job?.id || 'unknown' }, 'Broadcast job failed');
    });

    worker.on('error', error => {
      logger.error({ err: error }, 'Broadcast worker error');
    });

    logger.info({ rateLimitPerSecond: CONFIG.RATE_LIMIT }, 'Broadcast worker initialized');
    return worker;
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize broadcast worker');
    return null;
  }
}

async function createBroadcast(message, options = {}) {
  const { adminId, metadata = {}, filter = {} } = options;
  const broadcastId = uuidv4();

  const client = getClient();
  if (!client) {
    throw new Error('Redis not available');
  }

  const broadcastData = {
    broadcastId,
    message,
    adminId: adminId || 'system',
    metadata: JSON.stringify(metadata),
    filter: JSON.stringify(filter),
    status: 'pending',
    totalUsers: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    createdAt: new Date().toISOString()
  };

  await client.hset(`broadcast:${broadcastId}`, broadcastData);
  await client.expire(`broadcast:${broadcastId}`, 86400 * 7); // 7 day TTL

  logger.info({ broadcastId, adminId: adminId || 'system' }, 'Broadcast created');

  return broadcastId;
}

async function executeBroadcast(broadcastId) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis not available');
  }

  const broadcastData = await client.hgetall(`broadcast:${broadcastId}`);
  if (!broadcastData || !broadcastData.message) {
    throw new Error('Broadcast not found');
  }

  const q = getQueue();
  if (!q) {
    throw new Error('Broadcast queue not available');
  }

  logger.info({ broadcastId }, 'Fetching broadcast users via adapter');
  const userIds = [];
  let cursor = null;
  const PAGE_SIZE = 1000;
  const MAX_USERS = 10000;
  do {
    const page = await userAdapter.listActiveUsers({ limit: PAGE_SIZE, cursor });
    if (!page || !Array.isArray(page.users)) break;
    userIds.push(...page.users);
    cursor = page.nextCursor || null;
    if (userIds.length >= MAX_USERS) break;
  } while (cursor);

  if (userIds.length === 0) {
    await client.hset(`broadcast:${broadcastId}`, {
      status: 'completed',
      totalUsers: 0
    });
    return { broadcastId, userCount: 0 };
  }

  logger.info({ broadcastId, userCount: userIds.length }, 'Broadcast users fetched');

  await client.hset(`broadcast:${broadcastId}`, {
    status: 'processing',
    totalUsers: userIds.length
  });

  const jobs = userIds.map((userId, index) => ({
    name: 'broadcast-trigger',
    data: {
      broadcastId,
      userId,
      message: broadcastData.message,
      metadata: JSON.parse(broadcastData.metadata || '{}')
    },
    opts: {
      jobId: `${broadcastId}_${userId}_${Date.now()}`,
      delay: Math.floor(index / CONFIG.RATE_LIMIT) * 1000
    }
  }));

  const BATCH_SIZE = 100;
  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    await q.addBulk(batch);

    await client.hincrby(`broadcast:${broadcastId}`, 'queued', batch.length);

    if (jobs.length > 100 && (i + BATCH_SIZE) % 500 === 0) {
      logger.info(
        {
          broadcastId,
          queued: Math.min(i + BATCH_SIZE, jobs.length),
          totalJobs: jobs.length
        },
        'Broadcast jobs queued'
      );
    }
  }

  logger.info({ broadcastId, totalJobs: jobs.length }, 'Broadcast jobs queued');

  return { broadcastId, userCount: userIds.length };
}

async function updateBroadcastProgress(broadcastId, status) {
  const client = getClient();
  if (!client) return;

  try {
    const field = status === 'completed' ? 'completed' : 'failed';
    await client.hincrby(`broadcast:${broadcastId}`, field, 1);

    const data = await client.hgetall(`broadcast:${broadcastId}`);
    const total = parseInt(data.totalUsers, 10) || 0;
    const completed = parseInt(data.completed, 10) || 0;
    const failed = parseInt(data.failed, 10) || 0;

    if (completed + failed >= total && total > 0) {
      await client.hset(`broadcast:${broadcastId}`, {
        status: 'completed',
        completedAt: new Date().toISOString()
      });
      logger.info(
        { broadcastId, completed, failed },
        'Broadcast completed'
      );
    }
  } catch (error) {
    logger.error({ err: error, broadcastId }, 'Error updating broadcast progress');
  }
}

async function getBroadcastStatus(broadcastId) {
  const client = getClient();
  if (!client) return null;

  const data = await client.hgetall(`broadcast:${broadcastId}`);
  if (!data || !data.broadcastId) {
    return null;
  }

  return {
    broadcastId: data.broadcastId,
    status: data.status,
    totalUsers: parseInt(data.totalUsers, 10) || 0,
    queued: parseInt(data.queued, 10) || 0,
    completed: parseInt(data.completed, 10) || 0,
    failed: parseInt(data.failed, 10) || 0,
    adminId: data.adminId,
    createdAt: data.createdAt,
    completedAt: data.completedAt || null,
    progress: data.totalUsers > 0
      ? Math.round(((parseInt(data.completed, 10) || 0) + (parseInt(data.failed, 10) || 0)) / parseInt(data.totalUsers, 10) * 100)
      : 0
  };
}

async function closeBroadcast() {
  if (worker) {
    logger.info('Closing broadcast worker');
    await worker.close();
    worker = null;
  }

  if (queue) {
    logger.info('Closing broadcast queue');
    await queue.close();
    queue = null;
  }

  logger.info('Broadcast system closed');
}

module.exports = {
  createBroadcast,
  executeBroadcast,
  getBroadcastStatus,
  initializeWorker,
  closeBroadcast
};
