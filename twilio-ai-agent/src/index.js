require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const { createLogger, getRuntimeEnv, isProductionEnv } = require('./utils/logger');

const logger = createLogger('server');

const userAdapter = require('./adapters/user-adapter');
const smsWebhook = require('./routes/sms-webhook');
const whatsappWebhook = require('./routes/whatsapp-webhook');
const statusCallback = require('./routes/status-callback');
const triggerIngestion = require('./routes/trigger-ingestion');
const redisClient = require('./utils/redis-client');
const { initializeWorker, closeWorker, isRunning } = require('./timers/buffer-timer-worker');
const { closeQueue, getTimerInfo } = require('./timers/buffer-timer-manager');
const { getState, deleteState, CONFIG } = require('./state/conversation-state');
const { initializeWorker: initTriggerWorker, stopWorker: stopTriggerWorker, isWorkerRunning: isTriggerWorkerRunning, getHealth: getTriggerHealth } = require('./triggers/trigger-worker');
const { initializeWorker: initBroadcastWorker, closeBroadcast } = require('./triggers/broadcast-manager');

const REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'REDIS_URL',
  'CHAT_ENDPOINT_URL',
  'STATUS_CALLBACK_URL'
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error({ missing }, 'Missing required environment variables');
    if (isProductionEnv()) {
      process.exit(1);
    }
  }

  if (!process.env.TRIGGER_API_KEY) {
    logger.warn('TRIGGER_API_KEY not set; the /triggers endpoint will reject all requests with 503');
  }
}

const app = express();

app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((req, res, next) => {
  const incomingId = req.headers['x-request-id'];
  req.requestId = incomingId || crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: 'Too many requests',
  standardHeaders: true,
  legacyHeaders: false
});

function validateTwilioRequest(req, res, next) {
  if (!isProductionEnv()) {
    return next();
  }

  const signature = req.headers['x-twilio-signature'];
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${protocol}://${req.get('host')}${req.originalUrl}`;

  if (!signature) {
    logger.warn({ path: req.originalUrl, requestId: req.requestId }, 'Missing Twilio signature header');
    return res.status(403).send('Forbidden');
  }

  if (!process.env.TWILIO_AUTH_TOKEN) {
    logger.error({ requestId: req.requestId }, 'Twilio auth token not set');
    return res.status(500).send('Server configuration error');
  }

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    logger.warn({ path: req.originalUrl, requestId: req.requestId }, 'Invalid Twilio signature');
    logger.debug({ computedUrl: url, requestId: req.requestId }, 'Computed Twilio signature URL');
    return res.status(403).send('Forbidden');
  }

  next();
}

app.post('/sms/webhook', webhookLimiter, validateTwilioRequest, smsWebhook);
app.post('/whatsapp/webhook', webhookLimiter, validateTwilioRequest, whatsappWebhook);
app.post('/status/callback', webhookLimiter, validateTwilioRequest, statusCallback);

app.use('/triggers', triggerIngestion);

app.get('/health', async (req, res) => {
  const redisConnected = redisClient.isConnected();
  const workerRunning = isRunning();
  const triggerWorkerRunning = isTriggerWorkerRunning();

  let triggerHealth = { status: 'unknown' };
  try {
    triggerHealth = await getTriggerHealth();
  } catch (e) {
    triggerHealth = { status: 'error', error: e.message };
  }

  const allHealthy = redisConnected && workerRunning && triggerWorkerRunning;

  res.json({
    status: allHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    chatEndpointUrl: process.env.CHAT_ENDPOINT_URL || 'not configured',
    userAdapter: userAdapter.getMode(),
    redis: redisConnected ? 'connected' : 'disconnected',
    bufferWorker: workerRunning ? 'running' : 'stopped',
    triggerWorker: triggerWorkerRunning ? 'running' : 'stopped',
    triggerSystem: triggerHealth,
    config: {
      bufferBaseTimeout: CONFIG.BUFFER_BASE_TIMEOUT_MS,
      bufferGrowthFactor: CONFIG.BUFFER_GROWTH_FACTOR,
      bufferMaxTimeout: CONFIG.BUFFER_MAX_TIMEOUT_MS,
      maxReprocessAttempts: CONFIG.MAX_REPROCESS_ATTEMPTS
    }
  });
});

if (!isProductionEnv()) {
  app.get('/debug/state/:phone/:channel', async (req, res) => {
    const { phone, channel } = req.params;

    try {
      const state = await getState(phone, channel);
      const timerInfo = await getTimerInfo(phone, channel);

      if (!state) {
        return res.status(404).json({ error: 'No conversation state found' });
      }

      res.json({
        phone,
        channel,
        state,
        timer: timerInfo
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/debug/state/:phone/:channel', async (req, res) => {
    const { phone, channel } = req.params;

    try {
      await deleteState(phone, channel);
      res.json({ success: true, message: `State cleared for ${phone}/${channel}` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  logger.info({ env: getRuntimeEnv() }, 'Debug routes enabled');
}

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  logger.error({ err, requestId: req.requestId }, 'Unhandled server error');
  res.status(500).json({ error: 'Internal server error' });
});

let server = null;
let workersStarted = false;

function startWorkers() {
  if (workersStarted) return;
  initializeWorker();
  initTriggerWorker();
  initBroadcastWorker();
  workersStarted = true;
}

async function stopWorkers() {
  if (!workersStarted) return;
  await closeWorker();
  await closeQueue();
  await stopTriggerWorker();
  await closeBroadcast();
  workersStarted = false;
}

async function start({ port } = {}) {
  validateEnv();
  startWorkers();

  const targetPort = port !== undefined ? port : (process.env.PORT || 3001);
  await new Promise((resolve, reject) => {
    server = app.listen(targetPort, () => {
      const actualPort = server.address().port;
      logger.info(
        {
          port: actualPort,
          env: getRuntimeEnv(),
          chatEndpointUrl: process.env.CHAT_ENDPOINT_URL || 'not_configured',
          userAdapter: userAdapter.getMode(),
          redis: redisClient.isConnected() ? 'connected' : 'not_connected',
          statusCallbackConfigured: Boolean(process.env.STATUS_CALLBACK_URL),
          triggerApiConfigured: Boolean(process.env.TRIGGER_API_KEY)
        },
        'twilio-ai-agent started'
      );
      resolve();
    });
    server.on('error', reject);
  });
  return { app, server, port: server.address().port };
}

async function stop() {
  if (server) {
    // Forcibly close keepalive connections so the close() promise resolves
    // promptly. Without this, an integration-test harness can keep the event
    // loop alive for the keepalive idle timeout after all tests have passed.
    try { server.closeAllConnections?.(); } catch (_) { /* ignore */ }
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  await stopWorkers();
  await redisClient.gracefulShutdown();
}

async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  await stop();
  logger.info('Shutdown complete');
  process.exit(0);
}

// Auto-start unless explicitly disabled (e.g. by an integration test that
// wants to control the lifecycle itself).
if (process.env.AGENT_NO_AUTOSTART !== '1') {
  start().catch(err => {
    logger.error({ err }, 'Failed to start');
    process.exit(1);
  });
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { app, start, stop, startWorkers, stopWorkers };
