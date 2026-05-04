const { createLogger, maskMessageSid, maskPhone, truncateText } = require('../utils/logger');
const logger = createLogger('queue-manager');

const {
  generateQueueId,
  createQueue,
  getQueue,
  getQueueByMessageSid,
  updateQueue,
  setCurrentMessage,
  deleteQueue,
  deleteMessageMapping
} = require('./queue-state');
const { getStrategy } = require('./strategies');
const { sendMessage } = require('../utils/twilio-client');
const { storeOutboundMapping } = require('./read-receipt-store');
const {
  getState,
  markMessageDelivered,
  setCurrentMessageSid,
  transitionToIdle,
  STATES
} = require('../state/conversation-state');

const ERROR_MESSAGE = "Sorry, something went wrong. Try sending your message again.";

class MessageQueueManager {
  constructor(strategy) {
    this.strategy = strategy;
    this.timeouts = new Map(); // queueId -> { handle, startTime }
  }

  async sendMessages(phoneNumber, messages) {
    if (!messages || messages.length === 0) {
      return null;
    }

    const queueId = generateQueueId();
    const channel = this.strategy.getChannel();
    const maskedPhone = maskPhone(phoneNumber);

    logger.info({ queueId, channel, phone: maskedPhone }, 'Queue created');
    logger.debug({ queueId, messageCount: messages.length }, 'Queue messages prepared');

    try {
      await createQueue(queueId, phoneNumber, channel, messages);

      await setCurrentMessageSid(phoneNumber, channel, '');

      await this._sendMessage(queueId, phoneNumber, messages[0], 0, messages.length);

      return queueId;
    } catch (error) {
      logger.error({ err: error, queueId, channel }, 'Failed to create queue');
      await deleteQueue(queueId);
      throw error;
    }
  }

  async handleStatusCallback(messageSid, status, errorCode, phoneNumber = null) {
    const queueId = await getQueueByMessageSid(messageSid);
    const maskedSid = maskMessageSid(messageSid);

    if (!queueId) {
      logger.debug({ messageSid: maskedSid, status }, 'Status callback with no queue');
      return;
    }

    const queue = await getQueue(queueId);
    if (!queue) {
      logger.debug({ queueId, messageSid: maskedSid, status }, 'Status callback for expired queue');
      return;
    }

    const timeoutInfo = this.timeouts.get(queueId);
    const elapsed = timeoutInfo
      ? ((Date.now() - timeoutInfo.startTime) / 1000).toFixed(1)
      : '?';

    logger.debug(
      {
        queueId,
        messageSid: maskedSid,
        status,
        errorCode: errorCode || null,
        elapsedSeconds: elapsed
      },
      'Status callback received'
    );

    const channel = this.strategy.getChannel();
    const conversationState = phoneNumber ? await getState(phoneNumber, channel) : null;

    if (conversationState && conversationState.state !== STATES.SENDING) {
      logger.debug(
        { queueId, state: conversationState.state },
        'Conversation state not sending; ignoring callback'
      );
      this._clearTimeout(queueId);
      return;
    }

    const successStatus = this.strategy.getSuccessStatus();
    const retryStatuses = this.strategy.getRetryStatuses();

    if (status === successStatus) {
      if (phoneNumber) {
        try {
          await markMessageDelivered(phoneNumber, channel, queue.currentMessageIndex);
        } catch (stateError) {
          logger.warn({ err: stateError, queueId }, 'Failed to update conversation state');
        }
      }
      await this._sendNextMessage(queueId, phoneNumber);
    } else if (retryStatuses.includes(status)) {
      await this._retryCurrentMessage(queueId, status, errorCode, phoneNumber);
    }
  }

  async _sendMessage(queueId, phoneNumber, body, index, total) {
    const channel = this.strategy.getChannel();

    logger.debug(
      {
        queueId,
        channel,
        messageIndex: index + 1,
        messageTotal: total,
        bodyPreview: truncateText(body, 30),
        bodyLength: body.length
      },
      'Sending message'
    );

    try {
      const statusCallbackUrl = process.env.STATUS_CALLBACK_URL;
      const options = statusCallbackUrl ? { statusCallback: statusCallbackUrl } : {};

      if (index === 0 && statusCallbackUrl) {
        logger.debug({ queueId, statusCallbackUrl }, 'Status callback configured');
      } else if (index === 0 && !statusCallbackUrl) {
        logger.warn({ queueId }, 'Status callback URL not configured');
      }

      const message = await sendMessage(phoneNumber, body, channel, options);
      const maskedSid = maskMessageSid(message.sid);

      logger.debug({ queueId, messageSid: maskedSid }, 'Message sent');

      await setCurrentMessage(queueId, message.sid);

      try {
        await setCurrentMessageSid(phoneNumber, channel, message.sid);
      } catch (stateError) {
        logger.debug({ err: stateError, queueId }, 'Conversation state missing for message SID');
      }

      // Store persistent SID mapping for read receipt tracking (fire-and-forget)
      const state = await getState(phoneNumber, channel).catch(() => null);
      if (state && state.userId) {
        storeOutboundMapping(message.sid, {
          userId: state.userId,
          timestamp: new Date().toISOString(),
          channel
        }).catch(err => {
          logger.debug({ err, queueId }, 'Failed to store outbound message mapping');
        });
      }

      this._startTimeout(queueId);

      return message;
    } catch (error) {
      logger.error({ err: error, queueId, channel }, 'Message send failed');
      await this._abortQueue(queueId, `Send failed: ${error.message}`, phoneNumber);
      throw error;
    }
  }

  async _sendNextMessage(queueId, phoneNumber = null) {
    this._clearTimeout(queueId);

    const queue = await getQueue(queueId);
    if (!queue) {
      logger.warn({ queueId }, 'Queue not found');
      return;
    }

    if (queue.currentMessageSid) {
      await deleteMessageMapping(queue.currentMessageSid);
    }

    const nextIndex = queue.currentMessageIndex + 1;

    if (nextIndex >= queue.messages.length) {
      await this._completeQueue(queueId, queue, phoneNumber);
      return;
    }

    await updateQueue(queueId, {
      currentMessageIndex: nextIndex,
      retryCount: 0 // Reset retry count for new message
    });

    await this._sendMessage(
      queueId,
      queue.phoneNumber,
      queue.messages[nextIndex],
      nextIndex,
      queue.messages.length
    );
  }

  /**
   * Retry the current message
   * @private
   */
  async _retryCurrentMessage(queueId, status, errorCode, phoneNumber = null) {
    const queue = await getQueue(queueId);
    if (!queue) {
      return;
    }

    const maxRetries = this.strategy.getMaxRetries();
    const newRetryCount = queue.retryCount + 1;

    if (newRetryCount <= maxRetries) {
      logger.warn({ queueId, retryAttempt: newRetryCount, maxRetries }, 'Retrying message');
      this._clearTimeout(queueId);

      if (queue.currentMessageSid) {
        await deleteMessageMapping(queue.currentMessageSid);
      }

      await updateQueue(queueId, { retryCount: newRetryCount });

      await this._sendMessage(
        queueId,
        queue.phoneNumber,
        queue.messages[queue.currentMessageIndex],
        queue.currentMessageIndex,
        queue.messages.length
      );
    } else {
      await this._abortQueue(queueId, `Max retries exceeded (last status: ${status}, error: ${errorCode})`, phoneNumber);
    }
  }

  async _abortQueue(queueId, reason, phoneNumber = null) {
    this._clearTimeout(queueId);

    const queue = await getQueue(queueId);
    if (!queue) {
      return;
    }

    const remaining = queue.messages.length - queue.currentMessageIndex - 1;
    const maskedPhone = maskPhone(queue.phoneNumber);

    logger.error(
      {
        queueId,
        reason,
        failedMessageIndex: queue.currentMessageIndex + 1,
        messageTotal: queue.messages.length,
        remainingMessages: remaining
      },
      'Queue aborted'
    );

    await updateQueue(queueId, { status: 'failed' });

    const phone = phoneNumber || queue.phoneNumber;
    if (phone) {
      try {
        await transitionToIdle(phone, queue.channel);
      } catch (stateError) {
        logger.warn({ err: stateError, queueId }, 'Failed to transition to idle');
      }
    }

    try {
      logger.debug({ queueId, phone: maskedPhone }, 'Sending error message');
      await sendMessage(queue.phoneNumber, ERROR_MESSAGE, queue.channel);
    } catch (error) {
      logger.error({ err: error, queueId }, 'Failed to send error message');
    }

    setTimeout(async () => {
      await deleteQueue(queueId);
    }, 5000);
  }

  async _handleTimeout(queueId) {
    const queue = await getQueue(queueId);
    if (!queue) return;

    const messageSid = queue.currentMessageSid || 'unknown';
    const timeoutSeconds = (this.strategy.getTimeout() / 1000).toFixed(1);

    logger.warn(
      {
        queueId,
        waitingForMessageSid: maskMessageSid(messageSid),
        timeoutSeconds
      },
      'Timeout waiting for delivery confirmation; proceeding with next message'
    );

    await this._sendNextMessage(queueId, queue.phoneNumber);
  }

  async _completeQueue(queueId, queue, phoneNumber = null) {
    this._clearTimeout(queueId);

    logger.info({ queueId, messageTotal: queue.messages.length }, 'Queue completed');

    await updateQueue(queueId, { status: 'completed' });

    if (queue.currentMessageSid) {
      await deleteMessageMapping(queue.currentMessageSid);
    }

    await deleteQueue(queueId);

    const phone = phoneNumber || queue.phoneNumber;
    if (phone) {
      try {
        await transitionToIdle(phone, queue.channel);
        logger.debug({ queueId }, 'Conversation state transitioned to idle');
      } catch (stateError) {
        logger.warn({ err: stateError, queueId }, 'Failed to transition to idle');
      }
    }
  }

  _startTimeout(queueId) {
    this._clearTimeout(queueId);

    const timeout = this.strategy.getTimeout();
    const handle = setTimeout(() => {
      this._handleTimeout(queueId);
    }, timeout);

    this.timeouts.set(queueId, {
      handle,
      startTime: Date.now()
    });
  }

  _clearTimeout(queueId) {
    const timeoutInfo = this.timeouts.get(queueId);
    if (timeoutInfo) {
      clearTimeout(timeoutInfo.handle);
      this.timeouts.delete(queueId);
    }
  }

}

const managers = new Map();

function getManager(channel) {
  if (!managers.has(channel)) {
    const strategy = getStrategy(channel);
    managers.set(channel, new MessageQueueManager(strategy));
  }
  return managers.get(channel);
}

module.exports = {
  getManager
};
