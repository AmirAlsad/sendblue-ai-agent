require('dotenv').config();
const { Worker } = require('bullmq');
const { getQueueName, getConnectionConfig } = require('./buffer-timer-manager');
const { createLogger, maskPhone, maskUserId } = require('../utils/logger');

const logger = createLogger('buffer-worker');
const {
  getState,
  transitionToProcessing,
  transitionToSending,
  transitionToReprocessing,
  transitionToIdle,
  shouldReprocess,
  getAggregatedInput,
  STATES
} = require('../state/conversation-state');
const { callChatEndpointStreaming } = require('../adapters/chat-endpoint-client');
const { getManager } = require('../queue/message-queue-manager');
const { sendTypingIndicator } = require('../utils/twilio-typing');

let worker = null;

async function processBufferTimer(job) {
  const { phone, channel, messageCount } = job.data;
  const maskedPhone = maskPhone(phone);

  logger.info(
    { phone: maskedPhone, channel, messageCount, jobId: job.id },
    'Buffer timer fired'
  );

  try {
    const state = await getState(phone, channel);

    if (!state) {
      logger.debug({ phone: maskedPhone, channel, jobId: job.id }, 'Timer fired with no state');
      return;
    }

    if (state.state !== STATES.BUFFERING) {
      logger.debug(
        { phone: maskedPhone, channel, state: state.state },
        'Timer fired outside buffering state'
      );
      return;
    }

    await transitionToProcessing(phone, channel);

    // Fire WhatsApp typing indicator before calling ChatEngine
    if (channel === 'whatsapp' && state.lastInboundSid) {
      sendTypingIndicator(state.lastInboundSid).catch(() => {});
    }

    const { aggregatedText, repliedToSid, repliedToSentAt } = getAggregatedInput(state);
    logger.debug(
      { phone: maskedPhone, channel, messageCount: state.inboundBuffer.length },
      'Aggregated buffered messages'
    );

    logger.debug({ phone: maskedPhone, channel }, 'Calling chat endpoint (streaming)');

    let userData;
    if (state.userData) {
      try { userData = JSON.parse(state.userData); } catch { /* opaque blob; ignore parse fail */ }
    }

    const chatParams = {
      userId: state.userId,
      phoneNumber: phone,
      message: aggregatedText,
      interface: channel,
      ...(repliedToSid && { repliedToSid }),
      ...(repliedToSentAt && { repliedToSentAt }),
      ...(userData && { user: userData })
    };

    // Collect streamed messages, then send all at once after stream completes.
    // This avoids race conditions with queue lifecycle while still getting the
    // latency benefit of streaming (first message arrives faster from upstream).
    const streamedMessages = [];

    const chatResponse = await callChatEndpointStreaming(chatParams, async (text, _index) => {
      streamedMessages.push(text);
    });

    const stateAfterChat = await getState(phone, channel);
    if (!stateAfterChat) {
      logger.warn({ phone: maskedPhone, channel }, 'State disappeared during chat call');
      return;
    }

    if (shouldReprocess(stateAfterChat)) {
      logger.info(
        {
          phone: maskedPhone,
          channel,
          lateArrivalCount: stateAfterChat.lateArrivals.length
        },
        'Late arrivals detected; reprocessing'
      );
      const updatedState = await transitionToReprocessing(phone, channel);

      const { startTimer } = require('./buffer-timer-manager');
      const { calculateTimeout } = require('../state/conversation-state');
      const timeout = calculateTimeout(updatedState.inboundBuffer.length);
      await startTimer(phone, channel, updatedState.inboundBuffer.length, timeout);
      return;
    }

    if (stateAfterChat.lateArrivals.length > 0) {
      logger.warn(
        { phone: maskedPhone, channel, lateArrivalCount: stateAfterChat.lateArrivals.length },
        'Late arrivals present but reprocess limit reached'
      );
    }

    if (!chatResponse.success) {
      logger.error(
        {
          phone: maskedPhone,
          channel,
          userId: maskUserId(state.userId),
          error: chatResponse.error
        },
        'Chat endpoint error'
      );

      if (chatResponse.fallbackMessage) {
        const manager = getManager(channel);
        await manager.sendMessages(phone, [chatResponse.fallbackMessage]);
      }

      await transitionToIdle(phone, channel);
      return;
    }

    if (chatResponse.silence) {
      logger.info({ phone: maskedPhone, channel }, 'Chat endpoint chose silence');
      if (streamedMessages.length > 0) {
        logger.info(
          { phone: maskedPhone, channel, discardedCount: streamedMessages.length },
          'Discarding streamed messages due to silence flag'
        );
      }
      await transitionToIdle(phone, channel);
      return;
    }

    if (streamedMessages.length === 0) {
      logger.debug({ phone: maskedPhone, channel }, 'Chat endpoint returned no messages');
      await transitionToIdle(phone, channel);
      return;
    }

    logger.debug(
      { phone: maskedPhone, channel, messageCount: streamedMessages.length },
      'Chat endpoint streamed messages'
    );

    await transitionToSending(phone, channel, streamedMessages);

    const manager = getManager(channel);
    await manager.sendMessages(phone, streamedMessages);

  } catch (error) {
    logger.error({ err: error, phone: maskedPhone, channel }, 'Error processing buffer timer');

    try {
      await transitionToIdle(phone, channel);
    } catch (resetError) {
      logger.error({ err: resetError, phone: maskedPhone, channel }, 'Failed to reset state');
    }
  }
}

function initializeWorker() {
  if (worker) {
    logger.warn('Buffer timer worker already initialized');
    return worker;
  }

  const connection = getConnectionConfig();
  if (!connection) {
    logger.warn('Cannot initialize buffer timer worker; Redis not configured');
    return null;
  }

  const queueName = getQueueName();

  try {
    worker = new Worker(
      queueName,
      processBufferTimer,
      {
        connection,
        concurrency: 1,
        stalledInterval: 30000,
        lockDuration: 60000
      }
    );

    worker.on('completed', job => {
      logger.debug({ jobId: job.id }, 'Buffer timer job completed');
    });

    worker.on('failed', (job, error) => {
      logger.error(
        { err: error, jobId: job?.id || 'unknown' },
        'Buffer timer job failed'
      );
    });

    worker.on('error', error => {
      logger.error({ err: error }, 'Buffer timer worker error');
    });

    worker.on('stalled', jobId => {
      logger.warn({ jobId }, 'Buffer timer job stalled');
    });

    logger.info({ queueName }, 'Buffer timer worker initialized');
    return worker;
  } catch (error) {
    logger.error({ err: error, queueName }, 'Failed to initialize buffer timer worker');
    return null;
  }
}

async function closeWorker() {
  if (worker) {
    logger.info('Closing buffer timer worker');
    await worker.close();
    worker = null;
    logger.info('Buffer timer worker closed');
  }
}

function isRunning() {
  return worker !== null && !worker.closing;
}

module.exports = {
  initializeWorker,
  closeWorker,
  isRunning,
  processBufferTimer // Exported for testing
};
