const userAdapter = require('../adapters/user-adapter');
const { createLogger, maskUserId } = require('../utils/logger');

const logger = createLogger('channel-resolver');

const CHANNELS = {
  SMS: 'sms',
  WHATSAPP: 'whatsapp'
};

const DEFAULT_CHANNEL = CHANNELS.SMS;

async function resolveChannel(userId) {
  try {
    const userRecord = await userAdapter.resolveByUserId(userId);

    if (!userRecord) {
      logger.warn({ userId: maskUserId(userId) }, 'User not found; defaulting to SMS');
      return {
        success: false,
        channel: DEFAULT_CHANNEL,
        error: 'user_not_found',
        userData: null
      };
    }

    if (!userRecord.phone) {
      logger.warn({ userId: maskUserId(userId) }, 'User missing phone number');
      return {
        success: false,
        channel: null,
        error: 'no_phone_number',
        userData: userRecord
      };
    }

    const channel = userRecord.channel === CHANNELS.WHATSAPP ? CHANNELS.WHATSAPP : CHANNELS.SMS;

    return {
      success: true,
      channel,
      userData: {
        userId: userRecord.userId,
        phoneNumber: userRecord.phone,
        data: userRecord.data
      }
    };

  } catch (error) {
    logger.error({ err: error, userId: maskUserId(userId) }, 'Error resolving channel');
    return {
      success: false,
      channel: DEFAULT_CHANNEL,
      error: error.message,
      userData: null
    };
  }
}

module.exports = {
  resolveChannel
};
