const { getClient } = require('../utils/redis-client');
const { v4: uuidv4 } = require('uuid');
const { createLogger, maskUserId } = require('../utils/logger');

const logger = createLogger('trigger-queue');

const CONFIG = {
  QUEUE_TTL_DAYS: parseInt(process.env.TRIGGER_QUEUE_TTL_DAYS, 10) || 7,
  MAX_RETRIES: parseInt(process.env.TRIGGER_MAX_RETRIES, 10) || 2,
  RETRY_DELAY_MS: parseInt(process.env.TRIGGER_RETRY_DELAY_MS, 10) || 5000
};

const QUEUE_TTL_SECONDS = CONFIG.QUEUE_TTL_DAYS * 24 * 60 * 60;

function getTriggerQueueKey(userId) {
  return `triggers:pending:${userId}`;
}

function getTriggerLockKey(userId) {
  return `trigger_lock:${userId}`;
}

function validateTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') {
    return { valid: false, error: 'Trigger must be an object' };
  }

  if (!trigger.userId || typeof trigger.userId !== 'string') {
    return { valid: false, error: 'userId is required and must be a string' };
  }

  if (!trigger.message || typeof trigger.message !== 'string') {
    return { valid: false, error: 'message is required and must be a string' };
  }

  if (!trigger.timestamp) {
    return { valid: false, error: 'timestamp is required' };
  }

  // Validate timestamp is valid ISO 8601
  const date = new Date(trigger.timestamp);
  if (isNaN(date.getTime())) {
    return { valid: false, error: 'timestamp must be valid ISO 8601 format' };
  }

  return { valid: true };
}

async function enqueueTrigger(userId, trigger) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const validation = validateTrigger(trigger);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const enrichedTrigger = {
    ...trigger,
    triggerId: uuidv4(),
    enqueuedAt: new Date().toISOString(),
    retryCount: 0
  };

  const key = getTriggerQueueKey(userId);
  const triggerJson = JSON.stringify(enrichedTrigger);

  const pipeline = client.pipeline();
  pipeline.rpush(key, triggerJson); // Add to end of list (FIFO)
  pipeline.expire(key, QUEUE_TTL_SECONDS); // Refresh TTL
  const results = await pipeline.exec();

  const queueLength = results[0][1]; // rpush returns new length

  logger.info(
    {
      userId: maskUserId(userId),
      triggerId: enrichedTrigger.triggerId,
      queueLength
    },
    'Trigger enqueued'
  );

  return {
    triggerId: enrichedTrigger.triggerId,
    queueLength
  };
}

async function dequeueTrigger(userId) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getTriggerQueueKey(userId);
  const triggerJson = await client.lpop(key); // Pop from front (FIFO)

  if (!triggerJson) {
    return null;
  }

  try {
    return JSON.parse(triggerJson);
  } catch (error) {
    logger.error({ err: error, userId: maskUserId(userId) }, 'Failed to parse trigger JSON');
    return null;
  }
}

async function peekTriggers(userId, count = -1) {
  const client = getClient();
  if (!client) {
    return [];
  }

  const key = getTriggerQueueKey(userId);
  const triggers = await client.lrange(key, 0, count === -1 ? -1 : count - 1);

  return triggers.map(json => {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function getTriggerQueueLength(userId) {
  const client = getClient();
  if (!client) {
    return 0;
  }

  const key = getTriggerQueueKey(userId);
  return await client.llen(key);
}

async function getUsersWithPendingTriggers() {
  const client = getClient();
  if (!client) {
    return [];
  }

  const userIds = new Set();
  let cursor = '0';
  const pattern = 'triggers:pending:*';

  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;

    for (const key of keys) {
      const userId = key.replace('triggers:pending:', '');
      userIds.add(userId);
    }
  } while (cursor !== '0');

  return Array.from(userIds);
}

async function requeueTriggerForRetry(userId, trigger) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const newRetryCount = (trigger.retryCount || 0) + 1;
  if (newRetryCount > CONFIG.MAX_RETRIES) {
    logger.warn(
      { userId: maskUserId(userId), triggerId: trigger.triggerId, maxRetries: CONFIG.MAX_RETRIES },
      'Trigger exceeded max retries'
    );
    return false;
  }

  const retriedTrigger = {
    ...trigger,
    retryCount: newRetryCount,
    lastRetryAt: new Date().toISOString(),
    // Exponential backoff: 5s, 30s
    nextRetryDelay: CONFIG.RETRY_DELAY_MS * Math.pow(6, newRetryCount - 1)
  };

  const key = getTriggerQueueKey(userId);
  const triggerJson = JSON.stringify(retriedTrigger);

  const pipeline = client.pipeline();
  pipeline.lpush(key, triggerJson);
  pipeline.expire(key, QUEUE_TTL_SECONDS);
  await pipeline.exec();

  logger.info(
    {
      userId: maskUserId(userId),
      triggerId: trigger.triggerId,
      retryAttempt: newRetryCount,
      maxRetries: CONFIG.MAX_RETRIES
    },
    'Trigger requeued for retry'
  );

  return true;
}

async function addToDeadLetter(userId, trigger, error) {
  const client = getClient();
  if (!client) {
    logger.error({ userId: maskUserId(userId), triggerId: trigger.triggerId }, 'Redis unavailable for dead letter');
    return;
  }

  const deadLetterEntry = {
    ...trigger,
    userId,
    failedAt: new Date().toISOString(),
    error
  };

  await client.lpush('triggers:failed', JSON.stringify(deadLetterEntry));

  await client.ltrim('triggers:failed', 0, 999);

  logger.warn(
    { userId: maskUserId(userId), triggerId: trigger.triggerId, error },
    'Trigger added to dead letter queue'
  );
}

async function acquireLock(userId, ttlSeconds = 60) {
  const client = getClient();
  if (!client) {
    return false;
  }

  const key = getTriggerLockKey(userId);
  const result = await client.set(key, Date.now().toString(), 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

async function releaseLock(userId) {
  const client = getClient();
  if (!client) {
    return;
  }

  const key = getTriggerLockKey(userId);
  await client.del(key);
}

module.exports = {
  // Queue operations
  enqueueTrigger,
  dequeueTrigger,
  peekTriggers,
  getTriggerQueueLength,
  getUsersWithPendingTriggers,
  requeueTriggerForRetry,
  addToDeadLetter,

  // Lock operations
  acquireLock,
  releaseLock,

  // Utilities
  validateTrigger
};
