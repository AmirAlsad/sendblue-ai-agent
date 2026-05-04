/**
 * SMS Strategy
 *
 * Channel-specific configuration for SMS messages.
 * Uses E.164 phone numbers directly without transformation.
 */

const BaseStrategy = require('./base-strategy');

class SMSStrategy extends BaseStrategy {
  /**
   * Get the channel identifier
   * @returns {string} 'sms'
   */
  getChannel() {
    return 'sms';
  }
}

module.exports = SMSStrategy;
