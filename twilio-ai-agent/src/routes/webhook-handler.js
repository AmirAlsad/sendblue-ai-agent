const twilio = require('twilio');
const userAdapter = require('../adapters/user-adapter');
const gate = require('../utils/gate');
const {
  getState,
  initializeState,
  addToBuffer,
  addToLateArrivals,
  setLastInboundSid,
  calculateTimeout,
  STATES
} = require('../state/conversation-state');
const { startTimer } = require('../timers/buffer-timer-manager');
const { processInterruption } = require('../aggregation/interruption-handler');
const { getOutboundMapping } = require('../queue/read-receipt-store');
const { sendMessage } = require('../utils/twilio-client');
const { createLogger, maskPhone, maskUserId, truncateText } = require('../utils/logger');

const UNKNOWN_USER_MESSAGE = process.env.UNKNOWN_USER_MESSAGE || '';

/**
 * Create a webhook handler for the specified channel.
 */
function createWebhookHandler(channel) {
  const logger = createLogger(`${channel}-webhook`);

  return async function webhookHandler(req, res) {
    const requestId = req.requestId;
    const { From, Body, MessageSid, OriginalRepliedMessageSid } = req.body;
    const body = Body || '';
    const messageSid = MessageSid || 'unknown';

    const phoneNumber = (From || '').replace(/^whatsapp:/, '').replace(/\s+/g, '');
    const maskedPhone = maskPhone(phoneNumber);

    logger.info(
      {
        requestId,
        channel,
        phone: maskedPhone,
        messageSid
      },
      'Inbound message received'
    );
    if (body) {
      logger.debug(
        {
          requestId,
          channel,
          messageSid,
          bodyPreview: truncateText(body),
          bodyLength: body.length
        },
        'Inbound body preview'
      );
    }

    const twiml = new twilio.twiml.MessagingResponse();
    res.type('text/xml');
    res.send(twiml.toString());

    try {
      const userResult = await userAdapter.resolveByPhone(phoneNumber);

      if (!userResult) {
        if (UNKNOWN_USER_MESSAGE) {
          sendMessage(phoneNumber, UNKNOWN_USER_MESSAGE, channel).catch(err =>
            logger.warn({ err, requestId, phone: maskedPhone }, 'Failed to send unknown-user message')
          );
        }
        logger.info({ requestId, channel, phone: maskedPhone }, 'No user found; ignoring inbound');
        return;
      }

      const { userId, data: userData } = userResult;
      logger.debug({ requestId, userId: maskUserId(userId) }, 'User resolved');

      // Optional eligibility gate. Off by default; activates when the adapter
      // exports an isEligible predicate (or GATE_ELIGIBILITY_URL is set).
      const gateResult = await gate.evaluate(userAdapter.isEligible, userResult);
      if (!gateResult.allowed) {
        logger.info(
          { requestId, channel, userId: maskUserId(userId), decision: 'blocked' },
          'Inbound blocked by gate'
        );
        await gate.sendRedirectIfDue(userId, phoneNumber, channel, gateResult.redirect);
        return;
      }

      logger.debug(
        { requestId, channel, userId: maskUserId(userId), decision: 'passed' },
        'Inbound passed gate'
      );

      // Resolve WhatsApp reply context (non-blocking)
      let replyContext = null;
      if (channel === 'whatsapp' && OriginalRepliedMessageSid) {
        try {
          const mapping = await getOutboundMapping(OriginalRepliedMessageSid);
          if (mapping && mapping.userId === userId) {
            replyContext = {
              repliedToSid: OriginalRepliedMessageSid,
              repliedToSentAt: mapping.timestamp
            };
            logger.debug(
              { requestId, channel, repliedToSid: OriginalRepliedMessageSid },
              'Reply context resolved from outbound mapping'
            );
          }
        } catch (replyErr) {
          logger.debug(
            { requestId, channel, err: replyErr },
            'Reply context lookup failed; proceeding without annotation'
          );
        }
      }

      // Build buffer item: structured object with text and optional reply context
      const bufferItem = replyContext
        ? { text: body, ...replyContext }
        : { text: body };

      const currentState = await getState(phoneNumber, channel);
      const state = currentState?.state || STATES.IDLE;

      logger.debug({ requestId, channel, state }, 'Current conversation state');

      // userData is serialized into state so the buffer worker can forward it
      // to the chat endpoint as opaque metadata when the timer fires.
      const userDataJson = userData ? JSON.stringify(userData) : '';
      const stateMeta = { userData: userDataJson, userId, lastInboundSid: messageSid };

      switch (state) {
        case STATES.IDLE: {
          await initializeState(phoneNumber, channel, bufferItem, stateMeta);

          const timeout = calculateTimeout(1);
          await startTimer(phoneNumber, channel, 1, timeout);
          logger.info(
            { requestId, channel, phone: maskedPhone, timeoutMs: timeout },
            'State transition to buffering'
          );
          break;
        }

        case STATES.BUFFERING: {
          const updatedState = await addToBuffer(phoneNumber, channel, bufferItem, {
            lastInboundSid: messageSid
          });
          const messageCount = updatedState.inboundBuffer.length;

          const timeout = calculateTimeout(messageCount);
          await startTimer(phoneNumber, channel, messageCount, timeout);
          logger.info(
            {
              requestId,
              channel,
              phone: maskedPhone,
              messageCount,
              timeoutMs: timeout
            },
            'Buffering message'
          );
          break;
        }

        case STATES.PROCESSING: {
          await addToLateArrivals(phoneNumber, channel, bufferItem, {
            lastInboundSid: messageSid
          });
          logger.info({ requestId, channel, phone: maskedPhone }, 'Late arrival added for reprocessing');
          break;
        }

        case STATES.SENDING: {
          const deliveredCount = currentState.deliveredMessages?.length || 0;
          await processInterruption(phoneNumber, channel, bufferItem, deliveredCount);
          setLastInboundSid(phoneNumber, channel, messageSid).catch(err =>
            logger.warn({ err, requestId }, 'Failed to store lastInboundSid')
          );
          logger.info(
            { requestId, channel, phone: maskedPhone, deliveredCount },
            'Interruption triggered during sending'
          );
          break;
        }

        default:
          logger.warn({ requestId, channel, state }, 'Unknown state; treating as idle');
          await initializeState(phoneNumber, channel, bufferItem, stateMeta);
          await startTimer(phoneNumber, channel, 1, calculateTimeout(1));
      }
    } catch (error) {
      logger.error(
        { err: error, requestId, channel, messageSid },
        'Error processing inbound webhook'
      );
    }
  };
}

module.exports = { createWebhookHandler };
