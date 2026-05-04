const { createLogger } = require('../utils/logger');

const logger = createLogger('context-assembler');

const CANCELLED_MESSAGE_MAX_LENGTH = parseInt(process.env.CANCELLED_MESSAGE_MAX_LENGTH, 10) || 150;

function truncateMessage(message, maxLength = CANCELLED_MESSAGE_MAX_LENGTH) {
  if (!message) {
    return '';
  }

  if (message.length <= maxLength) {
    return message;
  }

  return message.substring(0, maxLength) + '...';
}

function formatInterruptedContext(cancelledMessages) {
  if (!cancelledMessages || cancelledMessages.length === 0) {
    return '';
  }

  const truncatedMessages = cancelledMessages.map(msg => truncateMessage(msg));
  const bulletPoints = truncatedMessages.map(msg => `- "${msg}"`).join('\n');

  return `[INTERRUPTED: The following messages were prepared but not sent due to user follow-up]\n${bulletPoints}`;
}

function formatDeliveredContext(deliveredMessages) {
  if (!deliveredMessages || deliveredMessages.length === 0) {
    return '';
  }

  return deliveredMessages.map(msg => `Assistant: ${msg}`).join('\n');
}

function buildInterruptionContext(options) {
  const {
    deliveredMessages = [],
    cancelledMessages = [],
    interruptingMessage = ''
  } = options;

  logger.debug(
    {
      deliveredCount: deliveredMessages.length,
      cancelledCount: cancelledMessages.length
    },
    'Building interruption context'
  );

  return {
    deliveredContext: formatDeliveredContext(deliveredMessages),
    interruptedContext: formatInterruptedContext(cancelledMessages),
    userMessage: interruptingMessage,
    fullContext: [
      formatDeliveredContext(deliveredMessages),
      formatInterruptedContext(cancelledMessages)
    ].filter(Boolean).join('\n\n')
  };
}

module.exports = {
  buildInterruptionContext
};
