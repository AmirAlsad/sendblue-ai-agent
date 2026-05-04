const { resolveChannel } = require('./channel-resolver');
const { callChatEndpointStreaming } = require('../adapters/chat-endpoint-client');
const userAdapter = require('../adapters/user-adapter');
const gate = require('../utils/gate');
const { getState, setState, transitionToSending, STATES } = require('../state/conversation-state');
const { getManager } = require('../queue/message-queue-manager');
const { sendTypingIndicator } = require('../utils/twilio-typing');
const { createLogger, maskPhone, maskUserId } = require('../utils/logger');

const logger = createLogger('trigger-processor');

const RESULT_TYPES = {
  SUCCESS: 'success',
  RETRY: 'retry',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

async function processTrigger(userId, trigger) {
  const startTime = Date.now();
  const triggerId = trigger.triggerId || 'unknown';
  const maskedUserId = maskUserId(userId);

  logger.info(
    { triggerId, triggerType: trigger.type, userId: maskedUserId },
    'Processing trigger'
  );

  try {
    const channelResult = await resolveChannel(userId);

    if (!channelResult.success) {
      if (channelResult.error === 'user_not_found') {
        logger.warn({ triggerId, userId: maskedUserId }, 'User not found in adapter');
        return {
          type: RESULT_TYPES.FAILED,
          error: 'user_not_found',
          message: 'User not found'
        };
      }

      if (channelResult.error === 'no_phone_number') {
        logger.warn({ triggerId, userId: maskedUserId }, 'User missing phone number');
        return {
          type: RESULT_TYPES.FAILED,
          error: 'no_phone_number',
          message: 'User has no phone number'
        };
      }

      logger.warn(
        { triggerId, userId: maskedUserId, error: channelResult.error },
        'Channel resolution failed'
      );
      return {
        type: RESULT_TYPES.RETRY,
        error: 'channel_resolution_failed',
        message: channelResult.error
      };
    }

    const { channel, userData } = channelResult;
    const { phoneNumber, data: userOpaqueData } = userData;
    const maskedPhone = maskPhone(phoneNumber);

    logger.debug(
      { triggerId, channel, phone: maskedPhone },
      'Trigger channel resolved'
    );

    // Optional eligibility gate. Mirrors inbound webhook behavior. Gated
    // triggers dead-letter (no retry).
    const gateResult = await gate.evaluate(userAdapter.isEligible, { userId, data: userOpaqueData });
    if (!gateResult.allowed) {
      logger.info(
        { triggerId, userId: maskedUserId, decision: 'gated' },
        'Trigger gated'
      );
      return {
        type: RESULT_TYPES.FAILED,
        error: 'gated_ineligible',
        message: 'User not eligible'
      };
    }

    const state = await getState(phoneNumber, channel);
    const currentState = state?.state || STATES.IDLE;

    if (currentState !== STATES.IDLE) {
      logger.info(
        { triggerId, userId: maskedUserId, currentState },
        'User not idle; skipping trigger'
      );
      return {
        type: RESULT_TYPES.SKIPPED,
        reason: 'user_not_idle',
        currentState
      };
    }

    // Fire WhatsApp typing indicator before calling the chat endpoint
    if (channel === 'whatsapp' && state?.lastInboundSid) {
      sendTypingIndicator(state.lastInboundSid).catch(() => {});
    }

    const chatParams = {
      userId,
      phoneNumber,
      message: trigger.message,
      interface: channel,
      trigger: {
        id: trigger.triggerId,
        ...(trigger.type && { type: trigger.type }),
        ...(trigger.metadata && { metadata: trigger.metadata })
      },
      ...(userOpaqueData && { user: userOpaqueData })
    };

    // Collect streamed messages, then send all at once after stream completes
    const streamedMessages = [];

    const chatResponse = await callChatEndpointStreaming(chatParams, async (text, _index) => {
      streamedMessages.push(text);
    });

    if (!chatResponse.success) {
      logger.warn(
        { triggerId, userId: maskedUserId, error: chatResponse.error },
        'Chat endpoint error for trigger'
      );
      return {
        type: RESULT_TYPES.RETRY,
        error: 'chat_endpoint_error',
        message: chatResponse.error || 'Chat endpoint request failed'
      };
    }

    if (chatResponse.silence) {
      if (streamedMessages.length > 0) {
        logger.info(
          { triggerId, userId: maskedUserId, discardedCount: streamedMessages.length },
          'Discarding streamed messages due to silence flag for trigger'
        );
      }
      logger.info({ triggerId, userId: maskedUserId }, 'Chat endpoint chose silence for trigger');
      return {
        type: RESULT_TYPES.SUCCESS,
        message: 'Silence'
      };
    }

    if (streamedMessages.length === 0) {
      logger.warn({ triggerId, userId: maskedUserId }, 'Chat endpoint returned no messages');
      return {
        type: RESULT_TYPES.FAILED,
        error: 'no_messages',
        message: 'Chat endpoint returned no messages'
      };
    }

    logger.info(
      { triggerId, messageCount: streamedMessages.length },
      'Chat endpoint streamed messages for trigger'
    );

    const userDataJson = userOpaqueData ? JSON.stringify(userOpaqueData) : '';

    if (!state) {
      await setState(phoneNumber, channel, {
        state: STATES.SENDING,
        inboundBuffer: [],
        lateArrivals: [],
        outboundQueue: streamedMessages,
        deliveredMessages: [],
        cancelledMessages: [],
        currentMessageSid: '',
        reprocessCount: 0,
        userData: userDataJson,
        userId
      });
    } else {
      await transitionToSending(phoneNumber, channel, streamedMessages);
    }

    const queueManager = getManager(channel);
    const queueId = await queueManager.sendMessages(phoneNumber, streamedMessages);

    const elapsed = Date.now() - startTime;
    logger.info(
      { triggerId, queueId, elapsedMs: elapsed },
      'Trigger processed successfully'
    );

    return {
      type: RESULT_TYPES.SUCCESS,
      queueId,
      messageCount: streamedMessages.length,
      elapsedMs: elapsed
    };

  } catch (error) {
    logger.error({ err: error, triggerId, userId: maskedUserId }, 'Error processing trigger');

    const isRetryable = !error.message.includes('Invalid trigger') &&
                        !error.message.includes('not found');

    return {
      type: isRetryable ? RESULT_TYPES.RETRY : RESULT_TYPES.FAILED,
      error: error.name || 'unknown_error',
      message: error.message
    };
  }
}

async function checkUserReadiness(userId) {
  try {
    const channelResult = await resolveChannel(userId);

    if (!channelResult.success || !channelResult.userData?.phoneNumber) {
      return {
        ready: false,
        reason: channelResult.error || 'no_phone_number'
      };
    }

    const { channel, userData } = channelResult;
    const { phoneNumber } = userData;

    const state = await getState(phoneNumber, channel);
    const currentState = state?.state || STATES.IDLE;

    return {
      ready: currentState === STATES.IDLE,
      currentState,
      channel,
      phoneNumber: maskPhone(phoneNumber)
    };

  } catch (error) {
    return {
      ready: false,
      reason: error.message
    };
  }
}

module.exports = {
  processTrigger,
  checkUserReadiness,
  RESULT_TYPES
};
