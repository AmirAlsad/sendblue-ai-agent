/**
 * Channel Strategies Index
 *
 * Factory function for getting channel-specific strategies.
 */

const SMSStrategy = require('./sms-strategy');
const WhatsAppStrategy = require('./whatsapp-strategy');

// Cache strategy instances (they're stateless, so we can reuse them)
const strategyCache = new Map();

/**
 * Get a strategy instance for the specified channel
 * @param {string} channel - 'sms' or 'whatsapp'
 * @returns {BaseStrategy} Strategy instance
 * @throws {Error} If channel is unknown
 */
function getStrategy(channel) {
  // Return cached instance if available
  if (strategyCache.has(channel)) {
    return strategyCache.get(channel);
  }

  let strategy;
  switch (channel) {
    case 'sms':
      strategy = new SMSStrategy();
      break;
    case 'whatsapp':
      strategy = new WhatsAppStrategy();
      break;
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }

  // Cache and return
  strategyCache.set(channel, strategy);
  return strategy;
}

module.exports = {
  getStrategy
};
