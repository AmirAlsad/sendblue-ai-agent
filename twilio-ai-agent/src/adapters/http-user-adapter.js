require('dotenv').config();
const fetch = require('node-fetch');
const { createLogger, maskPhone, maskUserId } = require('../utils/logger');

const logger = createLogger('http-user-adapter');

const USER_LOOKUP_URL = process.env.USER_LOOKUP_URL;
const GATE_ELIGIBILITY_URL = process.env.GATE_ELIGIBILITY_URL;
const LOOKUP_TIMEOUT_MS = parseInt(process.env.USER_LOOKUP_TIMEOUT_MS, 10) || 5000;

// In-memory caches keyed by phone and userId. We hold lookup results for the
// lifetime of the process so status-callback bursts and repeated trigger
// fan-outs don't hammer the upstream user-lookup webhook.
const phoneCache = new Map();
const userIdCache = new Map();

function isConfigured() {
  return Boolean(USER_LOOKUP_URL);
}

function normalizeUserRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (raw.userId === null || raw.userId === undefined) {
    return null;
  }
  return {
    userId: String(raw.userId),
    phone: raw.phone || raw.phoneNumber || null,
    channel: raw.channel === 'whatsapp' ? 'whatsapp' : 'sms',
    data: raw.data && typeof raw.data === 'object' ? raw.data : undefined
  };
}

async function postLookup(payload) {
  if (!USER_LOOKUP_URL) {
    return null;
  }
  try {
    const response = await fetch(USER_LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: LOOKUP_TIMEOUT_MS
    });

    if (!response.ok) {
      logger.warn({ status: response.status, payload }, 'User lookup endpoint returned non-OK');
      return null;
    }

    const text = await response.text();
    if (!text || text === 'null') {
      return null;
    }
    return JSON.parse(text);
  } catch (error) {
    logger.error({ err: error, payload }, 'User lookup request failed');
    return null;
  }
}

async function resolveByPhone(phone) {
  if (!phone) return null;
  if (phoneCache.has(phone)) {
    return phoneCache.get(phone);
  }

  if (!isConfigured()) {
    logger.warn({ phone: maskPhone(phone) }, 'USER_LOOKUP_URL not configured');
    return null;
  }

  const raw = await postLookup({ resolveBy: 'phone', value: phone });
  const record = normalizeUserRecord(raw);
  if (record) {
    phoneCache.set(phone, record);
    userIdCache.set(record.userId, record);
  } else {
    phoneCache.set(phone, null);
  }
  return record;
}

async function resolveByUserId(userId) {
  if (!userId) return null;
  if (userIdCache.has(userId)) {
    return userIdCache.get(userId);
  }

  if (!isConfigured()) {
    logger.warn({ userId: maskUserId(userId) }, 'USER_LOOKUP_URL not configured');
    return null;
  }

  const raw = await postLookup({ resolveBy: 'userId', value: userId });
  const record = normalizeUserRecord(raw);
  if (record) {
    userIdCache.set(userId, record);
    if (record.phone) {
      phoneCache.set(record.phone, record);
    }
  } else {
    userIdCache.set(userId, null);
  }
  return record;
}

async function listActiveUsers({ limit = 1000, cursor } = {}) {
  if (!isConfigured()) {
    logger.warn('USER_LOOKUP_URL not configured; broadcast listActiveUsers returning empty');
    return { users: [], nextCursor: null };
  }

  const payload = { resolveBy: 'listActive', limit };
  if (cursor) payload.cursor = cursor;

  const raw = await postLookup(payload);
  if (!raw || !Array.isArray(raw.users)) {
    return { users: [], nextCursor: null };
  }
  return {
    users: raw.users.map(String),
    nextCursor: raw.nextCursor || null
  };
}

async function isEligible({ userId, data }) {
  if (!GATE_ELIGIBILITY_URL) {
    return true;
  }
  try {
    const response = await fetch(GATE_ELIGIBILITY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, data }),
      timeout: LOOKUP_TIMEOUT_MS
    });
    if (!response.ok) {
      logger.warn({ status: response.status, userId: maskUserId(userId) }, 'Gate eligibility endpoint non-OK; failing open');
      return true;
    }
    const result = await response.json();
    if (typeof result === 'boolean') return result;
    if (result && typeof result === 'object') {
      if ('allowed' in result) return result;
    }
    return true;
  } catch (error) {
    logger.warn({ err: error, userId: maskUserId(userId) }, 'Gate eligibility request failed; failing open');
    return true;
  }
}

module.exports = {
  resolveByPhone,
  resolveByUserId,
  listActiveUsers,
  isEligible: GATE_ELIGIBILITY_URL ? isEligible : undefined,
  isConfigured
};
