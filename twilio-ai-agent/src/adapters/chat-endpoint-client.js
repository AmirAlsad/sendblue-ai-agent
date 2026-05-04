require('dotenv').config();
const fetch = require('node-fetch');
const { createLogger, maskPhone, maskUserId } = require('../utils/logger');

const logger = createLogger('chat-endpoint-client');

const CHAT_ENDPOINT_URL = process.env.CHAT_ENDPOINT_URL;
const READ_RECEIPT_URL = process.env.READ_RECEIPT_URL;

async function callChatEndpoint(params) {
  if (!CHAT_ENDPOINT_URL) {
    logger.error('CHAT_ENDPOINT_URL not configured');
    return {
      success: false,
      error: 'chat_endpoint_not_configured',
      fallbackMessage: "Sorry, something went wrong. Please try again later."
    };
  }

  try {
    logger.debug(
      {
        userId: maskUserId(params.userId),
        phone: maskPhone(params.phoneNumber),
        interface: params.interface,
        hasReplyContext: !!params.repliedToSid || undefined,
        hasTrigger: !!params.trigger || undefined
      },
      'Calling chat endpoint'
    );
    const response = await fetch(CHAT_ENDPOINT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params),
      timeout: 60000
    });

    const data = await response.json();
    return data;

  } catch (error) {
    logger.error(
      {
        err: error,
        userId: maskUserId(params.userId),
        phone: maskPhone(params.phoneNumber)
      },
      'Chat endpoint request failed'
    );
    return {
      success: false,
      error: 'chat_endpoint_error',
      fallbackMessage: "Sorry, something went wrong. Please try again later."
    };
  }
}

async function notifyReadReceipt({ userId, messageTimestamp, readAt, channel }) {
  if (!READ_RECEIPT_URL) {
    logger.debug({ userId: maskUserId(userId), channel }, 'READ_RECEIPT_URL not configured; dropping');
    return;
  }

  try {
    const response = await fetch(READ_RECEIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, messageTimestamp, readAt, channel }),
      timeout: 5000
    });

    if (!response.ok) {
      logger.warn(
        { userId: maskUserId(userId), status: response.status },
        'Read receipt endpoint returned non-OK'
      );
      return;
    }

    logger.debug(
      { userId: maskUserId(userId), channel },
      'Read receipt notification sent'
    );
  } catch (error) {
    logger.warn(
      { err: error, userId: maskUserId(userId) },
      'Failed to notify read receipt endpoint'
    );
  }
}

/**
 * Call the chat endpoint with streaming enabled.
 * Reads NDJSON response progressively and calls onMessage for each complete message.
 *
 * @param {Object} params - Same params as callChatEndpoint
 * @param {Function} onMessage - async (text, index) => void — called for each message as it arrives
 * @returns {Promise<Object>} The 'done' line data (success, silence, metadata)
 */
async function callChatEndpointStreaming(params, onMessage) {
  if (!CHAT_ENDPOINT_URL) {
    logger.error('CHAT_ENDPOINT_URL not configured');
    return {
      success: false,
      error: 'chat_endpoint_not_configured',
      fallbackMessage: "Sorry, something went wrong. Please try again later."
    };
  }

  try {
    logger.debug(
      {
        userId: maskUserId(params.userId),
        phone: maskPhone(params.phoneNumber),
        interface: params.interface,
        streaming: true
      },
      'Calling chat endpoint (streaming)'
    );

    const response = await fetch(CHAT_ENDPOINT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, stream: true }),
      timeout: 90000
    });

    // If the endpoint didn't return NDJSON (e.g. validation error), fall back to JSON
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('ndjson')) {
      const data = await response.json();
      if (data.success && data.messages) {
        for (let i = 0; i < data.messages.length; i++) {
          await onMessage(data.messages[i], i);
        }
      }
      return data;
    }

    // Read NDJSON stream line by line
    let doneData = null;
    let buffer = '';

    for await (const chunk of response.body) {
      buffer += chunk.toString();

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const parsed = JSON.parse(line);

          if (parsed.type === 'message') {
            await onMessage(parsed.text, parsed.index);
          } else if (parsed.type === 'done') {
            doneData = parsed;
          }
        } catch (parseErr) {
          logger.warn({ line: line.slice(0, 100) }, 'Failed to parse NDJSON line');
        }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.type === 'done') doneData = parsed;
        else if (parsed.type === 'message') await onMessage(parsed.text, parsed.index);
      } catch (parseErr) {
        logger.warn({ line: buffer.trim().slice(0, 100) }, 'Failed to parse final NDJSON buffer');
      }
    }

    if (!doneData) {
      logger.warn(
        { userId: maskUserId(params.userId) },
        'Streaming response ended without done line'
      );
      return { success: true, streamed: true };
    }

    return doneData;

  } catch (error) {
    logger.error(
      {
        err: error,
        userId: maskUserId(params.userId),
        phone: maskPhone(params.phoneNumber)
      },
      'Chat endpoint streaming request failed'
    );
    return {
      success: false,
      error: 'chat_endpoint_error',
      fallbackMessage: "Sorry, something went wrong. Please try again later."
    };
  }
}

module.exports = {
  callChatEndpoint,
  callChatEndpointStreaming,
  notifyReadReceipt
};
