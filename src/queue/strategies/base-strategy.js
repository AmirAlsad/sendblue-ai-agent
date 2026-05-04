/**
 * Base Strategy
 *
 * Abstract base class defining the interface for channel-specific strategies.
 * SMS and WhatsApp strategies extend this class.
 */

class BaseStrategy {
  /**
   * Get the status that indicates successful delivery
   * @returns {string} Success status (e.g., 'delivered')
   */
  getSuccessStatus() {
    return 'delivered';
  }

  /**
   * Get statuses that should trigger a retry
   * @returns {string[]} Array of retry-triggering statuses
   */
  getRetryStatuses() {
    return ['failed', 'undelivered'];
  }

  /**
   * Get timeout in milliseconds for waiting for delivery confirmation
   * @returns {number} Timeout in milliseconds
   */
  getTimeout() {
    return 30000; // 30 seconds
  }

  /**
   * Get maximum number of retry attempts per message
   * @returns {number} Max retries
   */
  getMaxRetries() {
    return 2;
  }

  /**
   * Get the channel identifier
   * @returns {string} Channel name (e.g., 'sms', 'whatsapp')
   */
  getChannel() {
    throw new Error('getChannel() must be implemented by subclass');
  }
}

module.exports = BaseStrategy;
