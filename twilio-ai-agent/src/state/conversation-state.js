const { getClient } = require('../utils/redis-client');
const { createLogger, maskPhone } = require('../utils/logger');

const logger = createLogger('conversation-state');

const CONVERSATION_TTL_SECONDS = 86400;

const STATES = {
  IDLE: 'idle',
  BUFFERING: 'buffering',
  PROCESSING: 'processing',
  SENDING: 'sending'
};

const CONFIG = {
  BUFFER_BASE_TIMEOUT_MS: parseInt(process.env.BUFFER_BASE_TIMEOUT_MS, 10) || 2000,
  BUFFER_GROWTH_FACTOR: parseFloat(process.env.BUFFER_GROWTH_FACTOR) || 1.25,
  BUFFER_MAX_TIMEOUT_MS: parseInt(process.env.BUFFER_MAX_TIMEOUT_MS, 10) || 8000,
  BUFFER_NOISE_MAX_DEVIATION: parseFloat(process.env.BUFFER_NOISE_MAX_DEVIATION) || 0.30,
  MAX_REPROCESS_ATTEMPTS: parseInt(process.env.MAX_REPROCESS_ATTEMPTS, 10) || 2,
  CANCELLED_MESSAGE_MAX_LENGTH: parseInt(process.env.CANCELLED_MESSAGE_MAX_LENGTH, 10) || 150
};

function getConversationKey(phone, channel) {
  return `conversation:${phone}:${channel}`;
}

function gaussianRandom(mean = 0, stdDev = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0 * stdDev + mean;
}

function calculateTimeout(messageCount) {
  const {
    BUFFER_BASE_TIMEOUT_MS,
    BUFFER_GROWTH_FACTOR,
    BUFFER_MAX_TIMEOUT_MS,
    BUFFER_NOISE_MAX_DEVIATION
  } = CONFIG;

  const calculatedTimeout = BUFFER_BASE_TIMEOUT_MS * Math.pow(BUFFER_GROWTH_FACTOR, messageCount - 1);
  const cappedTimeout = Math.min(calculatedTimeout, BUFFER_MAX_TIMEOUT_MS);

  const stdDev = cappedTimeout * BUFFER_NOISE_MAX_DEVIATION / 3;
  const noise = gaussianRandom(0, stdDev);
  let finalTimeout = cappedTimeout + noise;

  const minTimeout = BUFFER_BASE_TIMEOUT_MS * 0.5;
  const maxTimeout = BUFFER_MAX_TIMEOUT_MS * 1.5;
  finalTimeout = Math.max(minTimeout, Math.min(finalTimeout, maxTimeout));

  return Math.round(finalTimeout);
}

async function getState(phone, channel) {
  const client = getClient();
  if (!client) {
    return null;
  }

  const key = getConversationKey(phone, channel);
  const data = await client.hgetall(key);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    state: data.state || STATES.IDLE,
    inboundBuffer: JSON.parse(data.inboundBuffer || '[]'),
    lateArrivals: JSON.parse(data.lateArrivals || '[]'),
    outboundQueue: JSON.parse(data.outboundQueue || '[]'),
    deliveredMessages: JSON.parse(data.deliveredMessages || '[]'),
    cancelledMessages: JSON.parse(data.cancelledMessages || '[]'),
    currentMessageSid: data.currentMessageSid || '',
    currentTimerJobId: data.currentTimerJobId || '',
    reprocessCount: parseInt(data.reprocessCount, 10) || 0,
    userData: data.userData || '',
    userId: data.userId || '',
    lastActivity: parseInt(data.lastActivity, 10) || Date.now(),
    lastInboundSid: data.lastInboundSid || ''
  };
}

async function setState(phone, channel, stateData) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getConversationKey(phone, channel);

  const redisData = {
    lastActivity: String(Date.now())
  };

  for (const [field, value] of Object.entries(stateData)) {
    if (Array.isArray(value)) {
      redisData[field] = JSON.stringify(value);
    } else if (typeof value === 'number') {
      redisData[field] = String(value);
    } else if (value !== undefined && value !== null) {
      redisData[field] = String(value);
    }
  }

  const pipeline = client.pipeline();
  pipeline.hset(key, redisData);
  pipeline.expire(key, CONVERSATION_TTL_SECONDS);
  await pipeline.exec();
}

async function initializeState(phone, channel, message, metadata = {}) {
  const state = {
    state: STATES.BUFFERING,
    inboundBuffer: [message],
    lateArrivals: [],
    outboundQueue: [],
    deliveredMessages: [],
    cancelledMessages: [],
    currentMessageSid: '',
    reprocessCount: 0,
    userData: metadata.userData || '',
    userId: metadata.userId || '',
    lastInboundSid: metadata.lastInboundSid || ''
  };

  await setState(phone, channel, state);

  logger.info(
    { phone: maskPhone(phone), channel, state: STATES.BUFFERING, messageCount: 1 },
    'Conversation state initialized'
  );
  return state;
}

async function addToBuffer(phone, channel, message, opts = {}) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getConversationKey(phone, channel);

  await client.watch(key);

  try {
    const currentState = await getState(phone, channel);
    if (!currentState) {
      await client.unwatch();
      throw new Error('Conversation state not found');
    }

    const newBuffer = [...currentState.inboundBuffer, message];

    const hsetData = {
      inboundBuffer: JSON.stringify(newBuffer),
      lastActivity: String(Date.now())
    };
    if (opts.lastInboundSid) {
      hsetData.lastInboundSid = opts.lastInboundSid;
    }

    const pipeline = client.multi();
    pipeline.hset(key, hsetData);
    pipeline.expire(key, CONVERSATION_TTL_SECONDS);

    const results = await pipeline.exec();
    if (results === null) {
      throw new Error('Transaction aborted due to concurrent modification');
    }

    logger.debug(
      { phone: maskPhone(phone), channel, messageCount: newBuffer.length },
      'Message added to buffer'
    );
    return { ...currentState, inboundBuffer: newBuffer };
  } catch (error) {
    await client.unwatch();
    throw error;
  }
}

async function addToLateArrivals(phone, channel, message, opts = {}) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getConversationKey(phone, channel);

  await client.watch(key);

  try {
    const currentState = await getState(phone, channel);
    if (!currentState) {
      await client.unwatch();
      throw new Error('Conversation state not found');
    }

    const newLateArrivals = [...currentState.lateArrivals, message];

    const hsetData = {
      lateArrivals: JSON.stringify(newLateArrivals),
      lastActivity: String(Date.now())
    };
    if (opts.lastInboundSid) {
      hsetData.lastInboundSid = opts.lastInboundSid;
    }

    const pipeline = client.multi();
    pipeline.hset(key, hsetData);
    pipeline.expire(key, CONVERSATION_TTL_SECONDS);

    const results = await pipeline.exec();
    if (results === null) {
      throw new Error('Transaction aborted due to concurrent modification');
    }

    logger.debug(
      { phone: maskPhone(phone), channel, pendingLateArrivals: newLateArrivals.length },
      'Late arrival added'
    );
    return { ...currentState, lateArrivals: newLateArrivals };
  } catch (error) {
    await client.unwatch();
    throw error;
  }
}

async function transitionToProcessing(phone, channel) {
  const currentState = await getState(phone, channel);
  if (!currentState) {
    throw new Error('Conversation state not found');
  }

  await setState(phone, channel, {
    ...currentState,
    state: STATES.PROCESSING
  });

  logger.info(
    { phone: maskPhone(phone), channel, state: STATES.PROCESSING },
    'Conversation state transitioned to processing'
  );
  return { ...currentState, state: STATES.PROCESSING };
}

async function transitionToSending(phone, channel, outboundMessages) {
  const currentState = await getState(phone, channel);
  if (!currentState) {
    throw new Error('Conversation state not found');
  }

  const updatedState = {
    ...currentState,
    state: STATES.SENDING,
    outboundQueue: outboundMessages,
    inboundBuffer: [], // Clear buffer
    reprocessCount: 0  // Reset reprocess count
  };

  await setState(phone, channel, updatedState);

  logger.info(
    {
      phone: maskPhone(phone),
      channel,
      state: STATES.SENDING,
      messageCount: outboundMessages.length
    },
    'Conversation state transitioned to sending'
  );
  return updatedState;
}

async function transitionToReprocessing(phone, channel) {
  const currentState = await getState(phone, channel);
  if (!currentState) {
    throw new Error('Conversation state not found');
  }

  // Merge inbound buffer with late arrivals
  const mergedBuffer = [...currentState.inboundBuffer, ...currentState.lateArrivals];

  const updatedState = {
    ...currentState,
    state: STATES.BUFFERING,
    inboundBuffer: mergedBuffer,
    lateArrivals: [],
    reprocessCount: currentState.reprocessCount + 1
  };

  await setState(phone, channel, updatedState);

  logger.info(
    {
      phone: maskPhone(phone),
      channel,
      state: STATES.BUFFERING,
      reprocessCount: updatedState.reprocessCount,
      messageCount: mergedBuffer.length
    },
    'Conversation state transitioned to reprocessing'
  );
  return updatedState;
}

async function handleInterruption(phone, channel, interruptingMessage, sentIndex) {
  const currentState = await getState(phone, channel);
  if (!currentState) {
    throw new Error('Conversation state not found');
  }

  const delivered = currentState.outboundQueue.slice(0, sentIndex);
  const cancelled = currentState.outboundQueue.slice(sentIndex);

  const truncatedCancelled = cancelled.map(msg => {
    if (msg.length > CONFIG.CANCELLED_MESSAGE_MAX_LENGTH) {
      return msg.substring(0, CONFIG.CANCELLED_MESSAGE_MAX_LENGTH) + '...';
    }
    return msg;
  });

  const updatedState = {
    ...currentState,
    state: STATES.BUFFERING,
    inboundBuffer: [interruptingMessage],
    outboundQueue: [],
    deliveredMessages: [...currentState.deliveredMessages, ...delivered],
    cancelledMessages: truncatedCancelled,
    currentMessageSid: ''
  };

  await setState(phone, channel, updatedState);

  logger.info(
    {
      phone: maskPhone(phone),
      channel,
      state: STATES.BUFFERING,
      deliveredCount: delivered.length,
      cancelledCount: cancelled.length
    },
    'Conversation interrupted during sending'
  );
  return updatedState;
}

async function markMessageDelivered(phone, channel, messageIndex) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getConversationKey(phone, channel);

  await client.watch(key);

  try {
    const currentState = await getState(phone, channel);
    if (!currentState) {
      await client.unwatch();
      throw new Error('Conversation state not found');
    }

    const deliveredMsg = currentState.outboundQueue[messageIndex];
    if (deliveredMsg) {
      const newDelivered = [...currentState.deliveredMessages, deliveredMsg];

      const pipeline = client.multi();
      pipeline.hset(key, {
        deliveredMessages: JSON.stringify(newDelivered),
        lastActivity: String(Date.now())
      });
      pipeline.expire(key, CONVERSATION_TTL_SECONDS);

      const results = await pipeline.exec();
      if (results === null) {
        throw new Error('Transaction aborted due to concurrent modification');
      }

      return { ...currentState, deliveredMessages: newDelivered };
    }

    return currentState;
  } catch (error) {
    await client.unwatch();
    throw error;
  }
}

async function setCurrentMessageSid(phone, channel, messageSid) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getConversationKey(phone, channel);

  const pipeline = client.pipeline();
  pipeline.hset(key, {
    currentMessageSid: messageSid,
    lastActivity: String(Date.now())
  });
  pipeline.expire(key, CONVERSATION_TTL_SECONDS);
  await pipeline.exec();
}

async function setCurrentTimerJobId(phone, channel, jobId) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getConversationKey(phone, channel);

  const pipeline = client.pipeline();
  pipeline.hset(key, {
    currentTimerJobId: jobId,
    lastActivity: String(Date.now())
  });
  pipeline.expire(key, CONVERSATION_TTL_SECONDS);
  await pipeline.exec();
}

async function setLastInboundSid(phone, channel, messageSid) {
  const client = getClient();
  if (!client) {
    throw new Error('Redis client not available');
  }

  const key = getConversationKey(phone, channel);

  const pipeline = client.pipeline();
  pipeline.hset(key, {
    lastInboundSid: messageSid,
    lastActivity: String(Date.now())
  });
  pipeline.expire(key, CONVERSATION_TTL_SECONDS);
  await pipeline.exec();
}

async function transitionToIdle(phone, channel) {
  const currentState = await getState(phone, channel);

  const updatedState = {
    state: STATES.IDLE,
    inboundBuffer: [],
    lateArrivals: [],
    outboundQueue: [],
    deliveredMessages: [],
    cancelledMessages: [],
    currentMessageSid: '',
    currentTimerJobId: '',
    reprocessCount: 0,
    userData: currentState?.userData || '',
    userId: currentState?.userId || '',
    lastInboundSid: currentState?.lastInboundSid || ''
  };

  await setState(phone, channel, updatedState);

  logger.info(
    { phone: maskPhone(phone), channel, state: STATES.IDLE },
    'Conversation state transitioned to idle'
  );
}

async function deleteState(phone, channel) {
  const client = getClient();
  if (!client) {
    return;
  }

  const key = getConversationKey(phone, channel);
  await client.del(key);

  logger.info({ phone: maskPhone(phone), channel }, 'Conversation state deleted');
}

function shouldReprocess(state) {
  return state.lateArrivals.length > 0 &&
         state.reprocessCount < CONFIG.MAX_REPROCESS_ATTEMPTS;
}

function getAggregatedInput(state) {
  const items = (state.inboundBuffer || []).map(item => {
    if (typeof item === 'object' && item !== null) return item;
    return { text: item };
  });

  const aggregatedText = items.map(i => i.text).join('\n---\n');
  const firstWithReply = items.find(i => i.repliedToSid);

  return {
    aggregatedText,
    repliedToSid: firstWithReply?.repliedToSid || null,
    repliedToSentAt: firstWithReply?.repliedToSentAt || null
  };
}

module.exports = {
  // State operations
  getState,
  setState,
  initializeState,
  deleteState,

  // Buffer operations
  addToBuffer,
  addToLateArrivals,

  // State transitions
  transitionToProcessing,
  transitionToSending,
  transitionToReprocessing,
  transitionToIdle,
  handleInterruption,

  // Sending state operations
  markMessageDelivered,
  setCurrentMessageSid,
  setCurrentTimerJobId,
  setLastInboundSid,

  // Utilities
  shouldReprocess,
  getAggregatedInput,
  calculateTimeout,

  // Constants
  STATES,
  CONFIG
};
