require('dotenv').config();
const twilio = require('twilio');
const { createLogger, maskMessageSid, maskPhone } = require('./logger');

const logger = createLogger('twilio-client');

const requiredEnv = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];
const missing = requiredEnv.filter(key => !process.env[key]);

if (missing.length > 0) {
  logger.warn({ missing }, 'Missing Twilio env vars');
}

let client = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

function formatForWhatsApp(phoneNumber) {
  const cleanNumber = phoneNumber.replace(/^whatsapp:/, '');
  return `whatsapp:${cleanNumber}`;
}

async function sendMessage(to, body, channel = 'sms', options = {}) {
  if (!client) {
    throw new Error('Twilio client not initialized');
  }

  const messageParams = {
    body,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID
  };

  if (channel === 'whatsapp') {
    // WhatsApp needs explicit from/to with whatsapp: prefix
    messageParams.from = formatForWhatsApp(twilioPhoneNumber);
    messageParams.to = formatForWhatsApp(to);
  } else {
    // SMS: let Messaging Service pick the sender (RCS first, SMS fallback)
    messageParams.to = to;
    if (!process.env.TWILIO_MESSAGING_SERVICE_SID) {
      messageParams.from = twilioPhoneNumber;
    }
  }

  // Add statusCallback if provided
  if (options.statusCallback) {
    messageParams.statusCallback = options.statusCallback;
  }

  const message = await client.messages.create(messageParams);
  logger.debug(
    {
      channel,
      to: maskPhone(to),
      messageSid: maskMessageSid(message.sid)
    },
    'Twilio message created'
  );

  return message;
}

module.exports = {
  sendMessage
};
