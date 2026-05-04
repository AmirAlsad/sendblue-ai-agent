require('dotenv').config();
const Redis = require('ioredis');
const { createLogger } = require('./logger');

const logger = createLogger('redis');

let client = null;
let connectionStatus = 'disconnected';

function initializeClient() {
  if (client) {
    return client;
  }

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    logger.warn('Redis URL not configured; queue features disabled');
    return null;
  }

  try {
    client = new Redis(redisUrl, {
      retryStrategy(times) {
        if (times > 10) {
          logger.error('Redis max reconnection attempts reached');
          return null;
        }
        const delay = Math.min(times * 200, 5000);
        logger.debug({ delayMs: delay, attempt: times }, 'Redis reconnect scheduled');
        return delay;
      },
      connectTimeout: 10000,
      keepAlive: 30000,
      lazyConnect: false
    });

    client.on('connect', () => {
      logger.debug('Redis connecting');
    });

    client.on('ready', () => {
      connectionStatus = 'connected';
      logger.info('Redis connected');
    });

    client.on('error', err => {
      connectionStatus = 'error';
      logger.error({ err }, 'Redis connection error');
    });

    client.on('close', () => {
      connectionStatus = 'disconnected';
      logger.debug('Redis connection closed');
    });

    client.on('reconnecting', () => {
      connectionStatus = 'reconnecting';
    });

    client.on('end', () => {
      connectionStatus = 'disconnected';
      logger.debug('Redis connection ended');
    });

    return client;
  } catch (err) {
    logger.error({ err }, 'Redis initialization error');
    return null;
  }
}

function getClient() {
  if (!client) {
    initializeClient();
  }
  return client;
}

function isConnected() {
  return client !== null && connectionStatus === 'connected';
}

function getStatus() {
  if (!client) {
    return 'not_configured';
  }
  return connectionStatus;
}

async function gracefulShutdown() {
  if (client) {
    logger.info('Redis closing connection');
    try {
      await client.quit();
      logger.info('Redis connection closed gracefully');
    } catch (err) {
      logger.error({ err }, 'Redis error during shutdown');
      client.disconnect();
    }
    client = null;
    connectionStatus = 'disconnected';
  }
}

initializeClient();

module.exports = {
  getClient,
  isConnected,
  gracefulShutdown
};
