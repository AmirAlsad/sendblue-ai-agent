const { getManager } = require('../queue/message-queue-manager');
const { getOutboundMapping } = require('../queue/read-receipt-store');
const { notifyReadReceipt } = require('../adapters/chat-endpoint-client');
const { createLogger, maskPhone, maskMessageSid, maskUserId } = require('../utils/logger');

const logger = createLogger('status-callback');

async function statusCallback(req, res) {
  const { MessageSid, MessageStatus, ErrorCode, To, From } = req.body;
  const requestId = req.requestId;

  res.status(200).send('OK');

  try {
    const isWhatsApp = To && To.startsWith('whatsapp:');
    const channel = isWhatsApp ? 'whatsapp' : 'sms';

    const phoneNumber = To ? To.replace(/^whatsapp:/, '').replace(/\s+/g, '') : null;
    const maskedPhone = maskPhone(phoneNumber);
    const maskedSid = maskMessageSid(MessageSid);

    logger.debug(
      {
        requestId,
        channel,
        phone: maskedPhone,
        messageSid: maskedSid,
        status: MessageStatus,
        errorCode: ErrorCode || null
      },
      'Status callback received'
    );

    // Handle read receipts separately (RCS/WhatsApp only, arrives after queue deletion)
    if (MessageStatus === 'read') {
      await handleReadReceipt(MessageSid, channel);
      return;
    }

    const manager = getManager(channel);
    await manager.handleStatusCallback(MessageSid, MessageStatus, ErrorCode || null, phoneNumber);
  } catch (error) {
    logger.error({ err: error, requestId }, 'Error processing status callback');
  }
}

async function handleReadReceipt(messageSid, channel) {
  const maskedSid = maskMessageSid(messageSid);

  const mapping = await getOutboundMapping(messageSid);
  if (!mapping) {
    logger.debug({ messageSid: maskedSid }, 'Read receipt with no outbound mapping');
    return;
  }

  const readAt = new Date().toISOString();

  await notifyReadReceipt({
    userId: mapping.userId,
    messageTimestamp: mapping.timestamp,
    readAt,
    channel
  });

  // Clean up the mapping to prevent duplicate processing
  const { getClient } = require('../utils/redis-client');
  const client = getClient();
  if (client) {
    await client.del(`readmap:sid:${messageSid}`).catch(() => {});
  }

  logger.info(
    { messageSid: maskedSid, userId: maskUserId(mapping.userId) },
    'Read receipt forwarded to chat endpoint'
  );
}

module.exports = statusCallback;
