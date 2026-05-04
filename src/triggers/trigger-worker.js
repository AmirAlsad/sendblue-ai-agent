require('dotenv').config();
const { getClient } = require('../utils/redis-client');
const { createLogger, maskUserId } = require('../utils/logger');

const logger = createLogger('trigger-worker');
const {
  getUsersWithPendingTriggers,
  dequeueTrigger,
  acquireLock,
  releaseLock,
  requeueTriggerForRetry,
  addToDeadLetter,
  getTriggerQueueLength
} = require('./trigger-queue');
const { processTrigger, checkUserReadiness, RESULT_TYPES } = require('./trigger-processor');

const CONFIG = {
  POLL_INTERVAL_MS: parseInt(process.env.TRIGGER_POLL_INTERVAL_MS, 10) || 1000,
  LOCK_TTL_SECONDS: parseInt(process.env.TRIGGER_LOCK_TTL_SECONDS, 10) || 60,
  MAX_CONCURRENT_USERS: parseInt(process.env.TRIGGER_MAX_CONCURRENT_USERS, 10) || 10,
  RETRY_DELAY_MS: parseInt(process.env.TRIGGER_RETRY_DELAY_MS, 10) || 5000
};

let isRunning = false;
let pollHandle = null;
let processedCount = 0;
let failedCount = 0;
let skippedCount = 0;

async function processUserTriggers(userId) {
  const lockAcquired = await acquireLock(userId, CONFIG.LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    return { status: 'locked' };
  }

  try {
    const readiness = await checkUserReadiness(userId);

    const permanentFailures = ['user_not_found', 'no_phone_number'];
    if (!readiness.ready && permanentFailures.includes(readiness.reason)) {
      const trigger = await dequeueTrigger(userId);
      if (trigger) {
        await addToDeadLetter(userId, trigger, `Permanent failure: ${readiness.reason}`);
        failedCount++;
        logger.info(
          { userId: maskUserId(userId), triggerId: trigger.triggerId, reason: readiness.reason },
          'Trigger failed permanently'
        );
      }
      return { status: 'failed', reason: readiness.reason };
    }

    if (!readiness.ready) {
      skippedCount++;
      return { status: 'skipped', reason: readiness.reason || readiness.currentState };
    }

    const trigger = await dequeueTrigger(userId);
    if (!trigger) {
      return { status: 'empty' };
    }

    if (trigger.nextRetryDelay && trigger.lastRetryAt) {
      const lastRetry = new Date(trigger.lastRetryAt).getTime();
      const elapsed = Date.now() - lastRetry;
      if (elapsed < trigger.nextRetryDelay) {
        const client = getClient();
        if (client) {
          const key = `triggers:pending:${userId}`;
          await client.lpush(key, JSON.stringify(trigger));
        }
        return { status: 'delayed', remainingDelay: trigger.nextRetryDelay - elapsed };
      }
    }

    const result = await processTrigger(userId, trigger);

    switch (result.type) {
      case RESULT_TYPES.SUCCESS:
        processedCount++;
        return { status: 'success', triggerId: trigger.triggerId, messageCount: result.messageCount };

      case RESULT_TYPES.RETRY:
        const requeued = await requeueTriggerForRetry(userId, trigger);
        if (!requeued) {
          await addToDeadLetter(userId, trigger, result.message);
          failedCount++;
        }
        return { status: 'retry', triggerId: trigger.triggerId, requeued };

      case RESULT_TYPES.FAILED:
        await addToDeadLetter(userId, trigger, result.message);
        failedCount++;
        return { status: 'failed', triggerId: trigger.triggerId, error: result.message };

      case RESULT_TYPES.SKIPPED:
        const client = getClient();
        if (client) {
          const key = `triggers:pending:${userId}`;
          await client.lpush(key, JSON.stringify(trigger));
        }
        skippedCount++;
        return { status: 'skipped', reason: result.reason };

      default:
        return { status: 'unknown' };
    }

  } finally {
    await releaseLock(userId);
  }
}

async function pollForTriggers() {
  if (!isRunning) {
    return;
  }

  try {
    const userIds = await getUsersWithPendingTriggers();

    if (userIds.length > 0) {
      const batch = userIds.slice(0, CONFIG.MAX_CONCURRENT_USERS);

      await Promise.all(
        batch.map(userId => processUserTriggers(userId).catch(err => {
          logger.error({ err, userId: maskUserId(userId) }, 'Error processing user triggers');
        }))
      );
    }

  } catch (error) {
    logger.error({ err: error }, 'Error in trigger polling loop');
  }

  if (isRunning) {
    pollHandle = setTimeout(pollForTriggers, CONFIG.POLL_INTERVAL_MS);
  }
}

function initializeWorker() {
  if (isRunning) {
    logger.warn('Trigger worker already running');
    return true;
  }

  const client = getClient();
  if (!client) {
    logger.warn('Cannot initialize trigger worker; Redis not connected');
    return false;
  }

  isRunning = true;
  processedCount = 0;
  failedCount = 0;
  skippedCount = 0;

  logger.info(
    {
      pollIntervalMs: CONFIG.POLL_INTERVAL_MS,
      lockTtlSeconds: CONFIG.LOCK_TTL_SECONDS,
      maxConcurrentUsers: CONFIG.MAX_CONCURRENT_USERS
    },
    'Trigger worker started'
  );

  pollForTriggers();

  return true;
}

async function stopWorker() {
  if (!isRunning) {
    return;
  }

  logger.info('Stopping trigger worker');
  isRunning = false;

  if (pollHandle) {
    clearTimeout(pollHandle);
    pollHandle = null;
  }

  await new Promise(resolve => setTimeout(resolve, 100));

  logger.info(
    { processed: processedCount, failed: failedCount, skipped: skippedCount },
    'Trigger worker stopped'
  );
}

function isWorkerRunning() {
  return isRunning;
}

function getStats() {
  return {
    running: isRunning,
    processed: processedCount,
    failed: failedCount,
    skipped: skippedCount,
    config: CONFIG
  };
}

async function getHealth() {
  const client = getClient();
  const redisConnected = client !== null;

  let pendingUsers = 0;
  let totalPending = 0;

  if (redisConnected) {
    try {
      const userIds = await getUsersWithPendingTriggers();
      pendingUsers = userIds.length;

      for (const userId of userIds.slice(0, 100)) {
        totalPending += await getTriggerQueueLength(userId);
      }
    } catch (error) {
    }
  }

  return {
    status: isRunning && redisConnected ? 'healthy' : 'degraded',
    running: isRunning,
    redisConnected,
    pendingUsers,
    totalPending,
    stats: getStats()
  };
}

process.on('SIGTERM', async () => {
  logger.info({ signal: 'SIGTERM' }, 'Shutting down trigger worker');
  await stopWorker();
});

process.on('SIGINT', async () => {
  logger.info({ signal: 'SIGINT' }, 'Shutting down trigger worker');
  await stopWorker();
});

module.exports = {
  initializeWorker,
  stopWorker,
  isWorkerRunning,
  getStats,
  getHealth,

  // For testing
  processUserTriggers,
  CONFIG
};
