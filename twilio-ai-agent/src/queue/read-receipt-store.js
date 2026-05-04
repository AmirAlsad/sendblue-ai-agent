const { getClient } = require('../utils/redis-client');
const { createLogger, maskMessageSid, maskUserId } = require('../utils/logger');

const logger = createLogger('read-receipt-store');

const READ_RECEIPT_TTL_SECONDS = 259200; // 72 hours

function getSidKey(messageSid) {
  return `readmap:sid:${messageSid}`;
}

async function storeOutboundMapping(messageSid, { userId, timestamp, channel }) {
  const client = getClient();
  if (!client) return;

  const key = getSidKey(messageSid);
  const pipeline = client.pipeline();
  pipeline.hset(key, { userId, timestamp, channel });
  pipeline.expire(key, READ_RECEIPT_TTL_SECONDS);
  await pipeline.exec();

  logger.debug(
    { messageSid: maskMessageSid(messageSid), userId: maskUserId(userId) },
    'Outbound message mapping stored'
  );
}

async function getOutboundMapping(messageSid) {
  const client = getClient();
  if (!client) return null;

  const key = getSidKey(messageSid);
  const data = await client.hgetall(key);

  if (!data || !data.userId) return null;

  return { userId: data.userId, timestamp: data.timestamp, channel: data.channel };
}

module.exports = { storeOutboundMapping, getOutboundMapping };
