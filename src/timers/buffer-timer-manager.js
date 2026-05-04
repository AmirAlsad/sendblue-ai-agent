require('dotenv').config();
const { Queue } = require('bullmq');
const { setCurrentTimerJobId, getState } = require('../state/conversation-state');
const { createLogger, maskPhone } = require('../utils/logger');

const logger = createLogger('buffer-timer');

const QUEUE_NAME = process.env.BUFFER_QUEUE_NAME || 'buffer-timers';

function getRedisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.warn('Redis URL not configured; buffer timers disabled');
    return null;
  }

  const url = new URL(redisUrl);

  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {})
  };
}

let queue = null;

function getQueue() {
  if (queue) {
    return queue;
  }

  const connection = getRedisConnection();
  if (!connection) {
    return null;
  }

  try {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: 100, // Keep last 100 failed jobs for debugging
        attempts: 1 // No retries - if timer fails, conversation state handles it
      }
    });

    logger.info({ queueName: QUEUE_NAME }, 'Buffer timer queue initialized');
    return queue;
  } catch (error) {
    logger.error({ err: error, queueName: QUEUE_NAME }, 'Failed to initialize buffer timer queue');
    return null;
  }
}

function getJobId(phone, channel) {
  const sanitizedPhone = phone.replace(/^\+/, '');
  return `buffer_${sanitizedPhone}_${channel}`;
}

function getUniqueJobId(phone, channel) {
  return `${getJobId(phone, channel)}_${Date.now()}`;
}

async function startTimer(phone, channel, messageCount, timeoutMs) {
  const q = getQueue();
  if (!q) {
    logger.error({ phone: maskPhone(phone), channel }, 'Cannot start timer; queue unavailable');
    return false;
  }

  const baseJobId = getJobId(phone, channel);

  try {
    const currentState = await getState(phone, channel);
    const stateJobId = currentState?.currentTimerJobId;

    if (stateJobId && stateJobId !== baseJobId) {
      try {
        const stateJob = await q.getJob(stateJobId);
        if (stateJob) {
          await stateJob.remove();
          logger.debug({ phone: maskPhone(phone), channel, jobId: stateJobId }, 'Timer cancelled');
        }
      } catch (removeError) {
        if (!removeError.message.includes('locked') && !removeError.message.includes('Missing key')) {
          logger.warn(
            { err: removeError, phone: maskPhone(phone), channel },
            'Could not remove state-tracked timer'
          );
        }
      }
    }

    try {
      const baseJob = await q.getJob(baseJobId);
      if (baseJob) {
        await baseJob.remove();
        logger.debug({ phone: maskPhone(phone), channel, jobId: baseJobId }, 'Timer cancelled');
      }
    } catch (removeError) {
      if (!removeError.message.includes('locked') && !removeError.message.includes('Missing key')) {
        logger.warn(
          { err: removeError, phone: maskPhone(phone), channel },
          'Could not remove base timer'
        );
      }
    }

    const newJobId = getUniqueJobId(phone, channel);

    await q.add(
      'process-buffer',
      {
        phone,
        channel,
        messageCount,
        createdAt: Date.now()
      },
      {
        jobId: newJobId,
        delay: timeoutMs
      }
    );

    try {
      await setCurrentTimerJobId(phone, channel, newJobId);
    } catch (stateError) {
      logger.warn(
        { err: stateError, phone: maskPhone(phone), channel },
        'Failed to save timer job ID to state'
      );
    }

    logger.debug(
      {
        phone: maskPhone(phone),
        channel,
        timeoutMs,
        messageCount,
        jobId: newJobId
      },
      'Buffer timer scheduled'
    );
    return true;
  } catch (error) {
    logger.error({ err: error, phone: maskPhone(phone), channel }, 'Failed to start timer');
    return false;
  }
}

async function cancelTimer(phone, channel) {
  const q = getQueue();
  if (!q) {
    return true;
  }

  const baseJobId = getJobId(phone, channel);
  let cancelled = false;

  try {
    const currentState = await getState(phone, channel);
    const stateJobId = currentState?.currentTimerJobId;

    if (stateJobId) {
      const stateJob = await q.getJob(stateJobId);
      if (stateJob) {
        await stateJob.remove();
        cancelled = true;
        logger.debug({ phone: maskPhone(phone), channel, jobId: stateJobId }, 'Timer cancelled');
      }
    }
  } catch (error) {
    if (!error.message.includes('Missing key') && !error.message.includes('locked')) {
      logger.warn(
        { err: error, phone: maskPhone(phone), channel },
        'Could not cancel state-tracked timer'
      );
    }
  }

  try {
    const baseJob = await q.getJob(baseJobId);
    if (baseJob) {
      await baseJob.remove();
      if (!cancelled) {
        logger.debug({ phone: maskPhone(phone), channel, jobId: baseJobId }, 'Timer cancelled');
      }
      cancelled = true;
    }
  } catch (error) {
    if (!error.message.includes('Missing key') && !error.message.includes('locked')) {
      logger.warn(
        { err: error, phone: maskPhone(phone), channel },
        'Could not cancel base timer'
      );
    }
  }

  return true;
}

async function hasTimer(phone, channel) {
  const q = getQueue();
  if (!q) {
    return false;
  }

  const baseJobId = getJobId(phone, channel);
  let jobIdToCheck = baseJobId;

  try {
    const currentState = await getState(phone, channel);
    if (currentState?.currentTimerJobId) {
      jobIdToCheck = currentState.currentTimerJobId;
    }
  } catch {
  }

  try {
    const job = await q.getJob(jobIdToCheck);
    return job !== undefined && job !== null;
  } catch {
    return false;
  }
}

async function getTimerInfo(phone, channel) {
  const q = getQueue();
  if (!q) {
    return null;
  }

  const baseJobId = getJobId(phone, channel);
  let jobIdToCheck = baseJobId;

  try {
    const currentState = await getState(phone, channel);
    if (currentState?.currentTimerJobId) {
      jobIdToCheck = currentState.currentTimerJobId;
    }
  } catch {
  }

  try {
    const job = await q.getJob(jobIdToCheck);
    if (!job) {
      return null;
    }

    const state = await job.getState();
    return {
      jobId: job.id,
      state,
      data: job.data,
      delay: job.opts.delay,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn
    };
  } catch {
    return null;
  }
}

async function closeQueue() {
  if (queue) {
    logger.info('Closing buffer timer queue');
    await queue.close();
    queue = null;
    logger.info('Buffer timer queue closed');
  }
}

function getQueueInstance() {
  return getQueue();
}

function getQueueName() {
  return QUEUE_NAME;
}

function getConnectionConfig() {
  return getRedisConnection();
}

module.exports = {
  startTimer,
  getTimerInfo,
  closeQueue,
  getQueueName,
  getConnectionConfig
};
