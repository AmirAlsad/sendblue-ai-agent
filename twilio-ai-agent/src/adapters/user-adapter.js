require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../utils/logger');

const logger = createLogger('user-adapter');

const JS_ADAPTER_PATH = path.resolve(process.cwd(), 'adapters/user.js');

let mode = 'none';
let impl = null;

function loadJsAdapter() {
  if (!fs.existsSync(JS_ADAPTER_PATH)) {
    return null;
  }
  try {
    const loaded = require(JS_ADAPTER_PATH);
    if (typeof loaded.resolveByPhone !== 'function' || typeof loaded.resolveByUserId !== 'function') {
      throw new Error('adapter must export resolveByPhone and resolveByUserId');
    }
    return loaded;
  } catch (error) {
    logger.error({ err: error, path: JS_ADAPTER_PATH }, 'Failed to load JS user adapter');
    throw error;
  }
}

function loadHttpAdapter() {
  const httpAdapter = require('./http-user-adapter');
  if (!httpAdapter.isConfigured()) {
    return null;
  }
  return httpAdapter;
}

function buildStubs() {
  return {
    async resolveByPhone() { return null; },
    async resolveByUserId() { return null; },
    async listActiveUsers() { return { users: [], nextCursor: null }; }
  };
}

function init() {
  const jsAdapter = loadJsAdapter();
  if (jsAdapter) {
    impl = jsAdapter;
    mode = 'jsfile';
    logger.info({ path: JS_ADAPTER_PATH }, 'User adapter loaded from JS file');
    return;
  }

  const httpAdapter = loadHttpAdapter();
  if (httpAdapter) {
    impl = httpAdapter;
    mode = 'http';
    logger.info({ url: process.env.USER_LOOKUP_URL }, 'User adapter loaded from HTTP webhook');
    return;
  }

  impl = buildStubs();
  mode = 'none';
  logger.warn(
    'No user adapter configured. Set USER_LOOKUP_URL or create ./adapters/user.js. ' +
    'All user resolution will return null until configured.'
  );
}

init();

function getMode() {
  return mode;
}

async function resolveByPhone(phone) {
  return impl.resolveByPhone(phone);
}

async function resolveByUserId(userId) {
  return impl.resolveByUserId(userId);
}

async function listActiveUsers(opts) {
  if (typeof impl.listActiveUsers !== 'function') {
    return { users: [], nextCursor: null };
  }
  return impl.listActiveUsers(opts || {});
}

const isEligible = typeof impl?.isEligible === 'function' ? impl.isEligible.bind(impl) : null;

module.exports = {
  resolveByPhone,
  resolveByUserId,
  listActiveUsers,
  isEligible,
  getMode
};
