require('dotenv').config();
const { createLogger, maskUserId } = require('./logger');
const { getClient } = require('./redis-client');
const { sendMessage } = require('./twilio-client');

const logger = createLogger('gate');

const REDIRECT_TTL_SECONDS = parseInt(process.env.GATE_REDIRECT_TTL_SECONDS, 10) || 86400;
const REDIRECT_MESSAGE = process.env.GATE_REDIRECT_MESSAGE || '';

const REDIRECT_KEY_PREFIX = 'gate:redirect:';

/**
 * Atomically claim the per-user redirect window in Redis. Returns true if the
 * caller should send the redirect; false if a previous redirect is still
 * within the TTL window. Falls open (returns true) if Redis is unavailable so
 * a Redis outage doesn't permanently silence the gate.
 */
async function shouldSendRedirect(userId) {
  const client = getClient();
  if (!client) {
    return true;
  }

  try {
    const key = `${REDIRECT_KEY_PREFIX}${userId}`;
    const result = await client.set(key, '1', 'EX', REDIRECT_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn(
      { err, userId: maskUserId(userId) },
      'Redis rate-limit check failed; allowing redirect'
    );
    return true;
  }
}

/**
 * Send the redirect reply via Twilio if the rate-limit window is open.
 * Channel-mirrored: SMS → SMS, WhatsApp → WhatsApp, using the existing
 * Twilio sender wrapper. If GATE_REDIRECT_MESSAGE (or the per-call override)
 * is empty, the user is silently blocked with no Twilio send.
 *
 * @param {string} userId
 * @param {string} phoneNumber
 * @param {string} channel - 'sms' | 'whatsapp'
 * @param {string} [overrideMessage] - per-call override (returned by predicate)
 * @returns {Promise<{ sent: boolean, reason?: string, messageSid?: string }>}
 */
async function sendRedirectIfDue(userId, phoneNumber, channel, overrideMessage) {
  const message = overrideMessage || REDIRECT_MESSAGE;
  if (!message) {
    logger.debug(
      { userId: maskUserId(userId), channel, decision: 'redirect_skipped', reason: 'no_message_configured' },
      'Gate blocked but no redirect message configured; user silently blocked'
    );
    return { sent: false, reason: 'no_message_configured' };
  }

  const due = await shouldSendRedirect(userId);

  if (!due) {
    logger.info(
      {
        userId: maskUserId(userId),
        channel,
        decision: 'redirect_suppressed',
        reason: 'rate_limited'
      },
      'Gate redirect suppressed (rate-limited)'
    );
    return { sent: false, reason: 'rate_limited' };
  }

  try {
    const result = await sendMessage(phoneNumber, message, channel);
    logger.info(
      {
        userId: maskUserId(userId),
        channel,
        decision: 'redirect_sent',
        messageSid: result?.sid
      },
      'Gate redirect sent'
    );
    return { sent: true, messageSid: result?.sid };
  } catch (err) {
    logger.error(
      { err, userId: maskUserId(userId), channel },
      'Failed to send gate redirect'
    );
    return { sent: false, reason: 'error' };
  }
}

/**
 * Normalize the predicate's return value. Predicates may return a boolean or
 * an object { allowed: bool, redirect?: string }. Always returns
 * { allowed: bool, redirect?: string }.
 */
function normalizePredicateResult(result) {
  if (typeof result === 'boolean') {
    return { allowed: result };
  }
  if (result && typeof result === 'object') {
    return {
      allowed: result.allowed !== false,
      redirect: typeof result.redirect === 'string' ? result.redirect : undefined
    };
  }
  return { allowed: true };
}

/**
 * Run the gate predicate against a resolved user record. Returns a normalized
 * result so callers can either let the message through or send a redirect.
 *
 * @param {Function|null|undefined} predicate - async ({userId, data}) => bool|object
 * @param {{ userId: string, data?: object }} userRecord
 * @returns {Promise<{ allowed: boolean, redirect?: string }>}
 */
async function evaluate(predicate, userRecord) {
  if (typeof predicate !== 'function') {
    return { allowed: true };
  }
  try {
    const result = await predicate({ userId: userRecord.userId, data: userRecord.data });
    return normalizePredicateResult(result);
  } catch (err) {
    logger.warn(
      { err, userId: maskUserId(userRecord.userId) },
      'Gate predicate threw; failing open'
    );
    return { allowed: true };
  }
}

module.exports = {
  evaluate,
  shouldSendRedirect,
  sendRedirectIfDue,
  REDIRECT_MESSAGE,
  REDIRECT_TTL_SECONDS
};
