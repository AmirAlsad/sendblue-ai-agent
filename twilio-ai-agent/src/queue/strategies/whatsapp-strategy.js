/**
 * WhatsApp Strategy
 *
 * Channel-specific configuration for WhatsApp messages.
 * Adds 'whatsapp:' prefix to phone numbers.
 */

const BaseStrategy = require('./base-strategy');

class WhatsAppStrategy extends BaseStrategy {
  /**
   * Get the channel identifier
   * @returns {string} 'whatsapp'
   */
  getChannel() {
    return 'whatsapp';
  }
}

module.exports = WhatsAppStrategy;
