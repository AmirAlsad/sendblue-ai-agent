const pino = require('pino');

const SERVICE_NAME = 'twilio-ai-agent';
const runtimeEnv = process.env.NODE_ENV || 'development';
const isProduction = runtimeEnv === 'production';

const baseLogger = pino({
  level: isProduction ? 'info' : 'debug',
  base: { service: SERVICE_NAME, env: runtimeEnv },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: isProduction
    ? {
        paths: [
          'phone',
          'phoneNumber',
          'userId',
          'messageBody',
          'body',
          'payload',
          'requestBody'
        ],
        censor: '[redacted]'
      }
    : undefined
});

function createLogger(moduleName) {
  return baseLogger.child({ module: moduleName });
}

function maskPhone(phoneNumber) {
  if (!phoneNumber) {
    return 'unknown';
  }
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (!digits) {
    return 'unknown';
  }
  return `***${digits.slice(-4)}`;
}

function maskUserId(userId) {
  if (!userId) {
    return 'unknown';
  }
  const normalized = String(userId);
  return `***${normalized.slice(-6)}`;
}

function maskMessageSid(messageSid) {
  if (!messageSid) {
    return 'unknown';
  }
  const normalized = String(messageSid);
  return `${normalized.slice(0, 6)}...`;
}

function truncateText(value, maxLength = 50) {
  if (!value) {
    return '';
  }
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function getRuntimeEnv() {
  return runtimeEnv;
}

function isProductionEnv() {
  return isProduction;
}

module.exports = {
  createLogger,
  getRuntimeEnv,
  isProductionEnv,
  maskPhone,
  maskUserId,
  maskMessageSid,
  truncateText
};
