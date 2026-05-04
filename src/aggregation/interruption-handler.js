const {
  getState,
  handleInterruption,
  STATES
} = require('../state/conversation-state');
const { startTimer } = require('../timers/buffer-timer-manager');
const { calculateTimeout } = require('../state/conversation-state');
const { buildInterruptionContext } = require('./context-assembler');
const { createLogger, maskPhone, truncateText } = require('../utils/logger');

const logger = createLogger('interruption-handler');

async function processInterruption(phone, channel, message, deliveredCount) {
  const maskedPhone = maskPhone(phone);
  logger.info(
    {
      phone: maskedPhone,
      channel,
      deliveredCount,
      messagePreview: truncateText(typeof message === 'object' ? message.text : message)
    },
    'Processing interruption'
  );

  try {
    const currentState = await getState(phone, channel);
    if (!currentState) {
      throw new Error('No conversation state found');
    }

    if (currentState.state !== STATES.SENDING) {
      logger.info(
        { phone: maskedPhone, channel, state: currentState.state },
        'Ignoring interruption outside sending state'
      );
      return {
        interrupted: false,
        reason: `State is ${currentState.state}, not SENDING`
      };
    }

    const updatedState = await handleInterruption(phone, channel, message, deliveredCount);

    // Extract text from buffer item for context assembly
    const messageText = typeof message === 'object' && message !== null ? message.text : message;

    const context = buildInterruptionContext({
      deliveredMessages: updatedState.deliveredMessages,
      cancelledMessages: updatedState.cancelledMessages,
      interruptingMessage: messageText
    });

    const timeout = calculateTimeout(updatedState.inboundBuffer.length);
    await startTimer(
      phone,
      channel,
      updatedState.personality,
      updatedState.inboundBuffer.length,
      timeout
    );

    logger.info(
      {
        phone: maskedPhone,
        channel,
        deliveredCount: updatedState.deliveredMessages.length,
        cancelledCount: updatedState.cancelledMessages.length,
        timeoutMs: timeout
      },
      'Interruption handled'
    );

    return {
      interrupted: true,
      deliveredMessages: updatedState.deliveredMessages,
      cancelledMessages: updatedState.cancelledMessages,
      context,
      newState: updatedState
    };

  } catch (error) {
    logger.error({ err: error, phone: maskPhone(phone), channel }, 'Failed to process interruption');
    throw error;
  }
}

module.exports = {
  processInterruption
};
