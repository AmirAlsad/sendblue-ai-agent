const express = require('express');
const router = express.Router();
const { enqueueTrigger, validateTrigger } = require('../triggers/trigger-queue');
const { createLogger, maskUserId } = require('../utils/logger');

const logger = createLogger('trigger-ingestion');

const TRIGGER_API_KEY = process.env.TRIGGER_API_KEY;

function validateApiKey(req, res, next) {
  if (!TRIGGER_API_KEY) {
    logger.warn({ requestId: req.requestId }, 'Trigger API key not configured');
    return res.status(503).json({
      success: false,
      error: 'service_unavailable',
      message: 'Trigger ingestion not configured'
    });
  }

  const providedKey = req.headers['x-trigger-api-key'];

  if (!providedKey) {
    return res.status(401).json({
      success: false,
      error: 'missing_api_key',
      message: 'X-Trigger-API-Key header is required'
    });
  }

  if (providedKey !== TRIGGER_API_KEY) {
    logger.warn({ requestId: req.requestId }, 'Invalid trigger API key attempt');
    return res.status(401).json({
      success: false,
      error: 'invalid_api_key',
      message: 'Invalid API key'
    });
  }

  next();
}

router.post('/', validateApiKey, async (req, res) => {
  try {
    const requestId = req.requestId;
    const trigger = req.body;

    const validation = validateTrigger(trigger);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'invalid_trigger',
        message: validation.error
      });
    }

    if (trigger.userId === 'ALL') {
      const { createBroadcast, executeBroadcast } = require('../triggers/broadcast-manager');

      try {
        const broadcastId = await createBroadcast(trigger.message, {
          metadata: trigger.metadata,
          adminId: trigger.metadata?.adminId
        });

        executeBroadcast(broadcastId).catch(err => {
          logger.error({ err, requestId, broadcastId }, 'Broadcast execution error');
        });

        logger.info({ requestId, broadcastId }, 'Broadcast initiated');

        return res.status(202).json({
          success: true,
          broadcastId,
          message: 'Broadcast initiated'
        });
      } catch (broadcastError) {
        logger.error({ err: broadcastError, requestId }, 'Failed to create broadcast');
        return res.status(500).json({
          success: false,
          error: 'broadcast_failed',
          message: broadcastError.message
        });
      }
    }

    const result = await enqueueTrigger(trigger.userId, trigger);

    logger.info(
      {
        requestId,
        triggerId: result.triggerId,
        userId: maskUserId(trigger.userId)
      },
      'Trigger ingested'
    );

    return res.status(202).json({
      success: true,
      triggerId: result.triggerId,
      queuePosition: result.queueLength
    });

  } catch (error) {
    logger.error({ err: error, requestId: req.requestId }, 'Trigger ingestion error');

    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error.message
    });
  }
});

router.get('/health', async (req, res) => {
  try {
    const { getHealth } = require('../triggers/trigger-worker');
    const health = await getHealth();

    const statusCode = health.status === 'healthy' ? 200 : 503;

    return res.status(statusCode).json({
      service: 'trigger-system',
      ...health,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      service: 'trigger-system',
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/stats', validateApiKey, async (req, res) => {
  try {
    const { getStats } = require('../triggers/trigger-worker');
    const stats = getStats();

    return res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/user/:userId', validateApiKey, async (req, res) => {
  try {
    const { userId } = req.params;
    const { peekTriggers, getTriggerQueueLength } = require('../triggers/trigger-queue');

    const triggers = await peekTriggers(userId, 10); // Get up to 10
    const queueLength = await getTriggerQueueLength(userId);

    return res.json({
      success: true,
      userId,
      queueLength,
      triggers: triggers.map(t => ({
        triggerId: t.triggerId,
        type: t.type,
        timestamp: t.timestamp,
        enqueuedAt: t.enqueuedAt,
        retryCount: t.retryCount || 0
      }))
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/broadcast/:broadcastId', validateApiKey, async (req, res) => {
  try {
    const { broadcastId } = req.params;
    const { getBroadcastStatus } = require('../triggers/broadcast-manager');

    const status = await getBroadcastStatus(broadcastId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        message: 'Broadcast not found'
      });
    }

    return res.json({
      success: true,
      broadcastId,
      ...status
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
