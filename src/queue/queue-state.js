const { getClient } = require('../utils/redis-client');
const { createLogger, maskMessageSid, maskPhone } = require('../utils/logger');

const logger = createLogger('queue-state');

const QUEUE_TTL_SECONDS = 300;

function generateQueueId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'q_';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function getQueueKey(queueId) {
  return `queue:${queueId}`;
}

function getMessageKey(messageSid) {
  return `message:${messageSid}`;
}

async function createQueue(queueId, phoneNumber, channel, messages) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const now = new Date().toISOString();
  const key = getQueueKey(queueId);

  const queueData = {
    phoneNumber,
    channel,
    messages: JSON.stringify(messages),
    currentMessageSid: '',
    currentMessageIndex: '0',
    retryCount: '0',
    status: 'sending',
    createdAt: now,
    updatedAt: now
  };

  const pipeline = client.pipeline();
  pipeline.hset(key, queueData);
  pipeline.expire(key, QUEUE_TTL_SECONDS);
  await pipeline.exec();

  logger.debug(
    {
      queueId,
      channel,
      phone: maskPhone(phoneNumber),
      messageCount: messages.length
    },
    'Queue created'
  );
}

async function getQueue(queueId) {
  const client = getClient();
  if (!client) {
    return null;
  }

  const key = getQueueKey(queueId);
  const data = await client.hgetall(key);

  if (!data || Object.keys(data).length === 0) {
    logger.debug({ queueId }, 'Queue not found');
    return null;
  }

  logger.debug(
    {
      queueId,
      status: data.status,
      messageIndex: Number(data.currentMessageIndex)
    },
    'Queue retrieved'
  );

  // Parse and convert types
  return {
    phoneNumber: data.phoneNumber,
    channel: data.channel,
    messages: JSON.parse(data.messages || '[]'),
    currentMessageSid: data.currentMessageSid || '',
    currentMessageIndex: parseInt(data.currentMessageIndex, 10) || 0,
    retryCount: parseInt(data.retryCount, 10) || 0,
    status: data.status,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

async function getQueueByMessageSid(messageSid) {
  const client = getClient();
  if (!client) {
    return null;
  }

  const key = getMessageKey(messageSid);
  return await client.get(key);
}

async function updateQueue(queueId, updates) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getQueueKey(queueId);

  const redisUpdates = {
    updatedAt: new Date().toISOString()
  };

  for (const [field, value] of Object.entries(updates)) {
    if (field === 'messages') {
      redisUpdates[field] = JSON.stringify(value);
    } else if (typeof value === 'number') {
      redisUpdates[field] = String(value);
    } else {
      redisUpdates[field] = value;
    }
  }

  const pipeline = client.pipeline();
  pipeline.hset(key, redisUpdates);
  pipeline.expire(key, QUEUE_TTL_SECONDS); // Refresh TTL
  await pipeline.exec();
}

async function setCurrentMessage(queueId, messageSid) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const queueKey = getQueueKey(queueId);
  const messageKey = getMessageKey(messageSid);

  const pipeline = client.pipeline();

  pipeline.hset(queueKey, {
    currentMessageSid: messageSid,
    status: 'waiting',
    updatedAt: new Date().toISOString()
  });
  pipeline.expire(queueKey, QUEUE_TTL_SECONDS);

  pipeline.set(messageKey, queueId);
  pipeline.expire(messageKey, QUEUE_TTL_SECONDS);

  await pipeline.exec();

  logger.debug({ queueId, messageSid: maskMessageSid(messageSid) }, 'Current message set');
}

async function deleteQueue(queueId) {
  const client = getClient();
  if (!client) {
    return;
  }

  const queue = await getQueue(queueId);
  const queueKey = getQueueKey(queueId);

  const pipeline = client.pipeline();

  pipeline.del(queueKey);

  if (queue && queue.currentMessageSid) {
    const messageKey = getMessageKey(queue.currentMessageSid);
    pipeline.del(messageKey);
  }

  await pipeline.exec();

  logger.debug({ queueId }, 'Queue deleted');
}

async function deleteMessageMapping(messageSid) {
  const client = getClient();
  if (!client) {
    return;
  }

  const key = getMessageKey(messageSid);
  await client.del(key);
}

module.exports = {
  generateQueueId,
  createQueue,
  getQueue,
  getQueueByMessageSid,
  updateQueue,
  setCurrentMessage,
  deleteQueue,
  deleteMessageMapping
};
