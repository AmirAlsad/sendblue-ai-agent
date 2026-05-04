'use strict';

const https = require('https');
const { createLogger, maskMessageSid } = require('./logger');

const logger = createLogger('twilio-typing');

/**
 * Send a WhatsApp typing indicator for the given inbound MessageSid.
 *
 * The Twilio v2 Indicators API automatically marks the referenced inbound
 * message as read (blue checkmarks) and shows a typing bubble to the user.
 * The bubble disappears after 25 seconds or when the next message is delivered.
 *
 * This function NEVER throws. All errors are caught and logged at warn level
 * because a typing indicator failure must not affect message delivery.
 *
 * @param {string} messageSid - Inbound SM-prefixed MessageSid from Twilio
 * @returns {Promise<void>}
 */
async function sendTypingIndicator(messageSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    logger.debug('Twilio credentials not configured; skipping typing indicator');
    return;
  }

  if (!messageSid || !String(messageSid).startsWith('SM')) {
    logger.debug(
      { messageSid: maskMessageSid(messageSid) },
      'No valid inbound SID; skipping typing indicator'
    );
    return;
  }

  const body = new URLSearchParams({
    messageId: messageSid,
    channel: 'whatsapp'
  }).toString();

  const options = {
    hostname: 'messaging.twilio.com',
    path: '/v2/Indicators/Typing.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`
    }
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.resume();

      if (res.statusCode >= 200 && res.statusCode < 300) {
        logger.debug(
          { messageSid: maskMessageSid(messageSid), statusCode: res.statusCode },
          'Typing indicator sent'
        );
      } else {
        logger.warn(
          { messageSid: maskMessageSid(messageSid), statusCode: res.statusCode },
          'Typing indicator returned non-2xx'
        );
      }
      resolve();
    });

    req.on('error', (err) => {
      logger.warn(
        { err, messageSid: maskMessageSid(messageSid) },
        'Typing indicator request failed'
      );
      resolve();
    });

    req.setTimeout(5000, () => {
      logger.warn(
        { messageSid: maskMessageSid(messageSid) },
        'Typing indicator request timed out'
      );
      req.destroy();
      resolve();
    });

    req.write(body);
    req.end();
  });
}

module.exports = { sendTypingIndicator };
