import type { Counter, Gauge, Histogram, MetricsCollector } from './collector.js';
import { DEFAULT_LATENCY_BUCKETS_SECONDS } from './collector.js';

/**
 * The full set of named metric handles instrumented across the agent. Created
 * once per `createApp` call against the configured collector. Call sites pull
 * the specific handle they need from this registry; the registry shape is the
 * source of truth for label cardinality and bucket boundaries.
 */
export type AgentMetrics = {
  webhookReceived: Counter;
  webhookSecretRejections: Counter;
  webhookParseFailures: Counter;
  webhookDedupe: Counter;
  chatDispatchDuration: Histogram;
  outboundSendDuration: Histogram;
  outboundSendTotal: Counter;
  transientRetryTotal: Counter;
  smsLimitStallTotal: Counter;
  deliveryTimeoutFired: Counter;
  statusCallbackTotal: Counter;
  statusToTerminalDuration: Histogram;
  acquireSendSlotDelay: Histogram;
  limitThresholdCrossings: Counter;
  bufferJobsTotal: Counter;
  agentUp: Gauge;
  agentBuildInfo: Gauge;
};

const ACQUIRE_SLOT_BUCKETS_SECONDS = Object.freeze([0, 0.05, 0.1, 0.25, 0.5, 1, 2]);

/** Map error_code to a bounded set so cardinality stays predictable. */
const KNOWN_ERROR_CODES = new Set([
  '4000',
  '4001',
  '4002',
  '5000',
  '5003',
  '5509',
  '10001',
  '10002',
  'SMS_LIMIT_REACHED'
]);

export function normalizeErrorCodeLabel(code: string | undefined): string {
  if (!code) return 'none';
  return KNOWN_ERROR_CODES.has(code) ? code : 'other';
}

export function createAgentMetrics(collector: MetricsCollector): AgentMetrics {
  return {
    webhookReceived: collector.counter('webhook_received_total', {
      help: 'Sendblue webhooks received, broken down by type and disposition.',
      labels: ['type', 'result']
    }),
    webhookSecretRejections: collector.counter('webhook_secret_rejections_total', {
      help: 'Sendblue webhooks rejected because the shared-secret header did not match.',
      labels: ['route']
    }),
    webhookParseFailures: collector.counter('webhook_parse_failures_total', {
      help: 'Sendblue webhooks that passed secret validation but failed to parse.',
      labels: ['type', 'reason']
    }),
    webhookDedupe: collector.counter('webhook_dedupe_total', {
      help: 'Inbound message dedupe outcomes keyed on message_handle.',
      labels: ['result']
    }),
    chatDispatchDuration: collector.histogram('chat_dispatch_duration_seconds', {
      help: 'Wall-clock seconds spent in a single chat endpoint dispatch.',
      labels: ['result'],
      buckets: DEFAULT_LATENCY_BUCKETS_SECONDS
    }),
    outboundSendDuration: collector.histogram('outbound_send_duration_seconds', {
      help: 'Wall-clock seconds for one outbound action (Sendblue API call).',
      labels: ['operation', 'result'],
      buckets: DEFAULT_LATENCY_BUCKETS_SECONDS
    }),
    outboundSendTotal: collector.counter('outbound_send_total', {
      help: 'Outbound actions attempted, by operation/channel/result/error_code.',
      labels: ['operation', 'channel', 'result', 'error_code']
    }),
    transientRetryTotal: collector.counter('transient_retry_total', {
      help: 'Transient-error retry events for outbound actions.',
      labels: ['action', 'outcome']
    }),
    smsLimitStallTotal: collector.counter('sms_limit_stall_total', {
      help: 'SMS_LIMIT_REACHED stall lifecycle events keyed per Sendblue line.',
      labels: ['event']
    }),
    deliveryTimeoutFired: collector.counter('delivery_timeout_fired_total', {
      help: 'Outbound delivery-timeout callbacks that fired without a terminal status.'
    }),
    statusCallbackTotal: collector.counter('status_callback_total', {
      help: 'Sendblue status callbacks observed, by status/channel/error_category.',
      labels: ['status', 'channel', 'error_category']
    }),
    statusToTerminalDuration: collector.histogram('status_to_terminal_seconds', {
      help: 'Seconds from first SENT/ACCEPTED to a terminal status callback.',
      labels: ['terminal', 'channel'],
      buckets: DEFAULT_LATENCY_BUCKETS_SECONDS
    }),
    acquireSendSlotDelay: collector.histogram('acquire_send_slot_delay_seconds', {
      help: 'Pre-emptive pacing delay applied by LimitTracker.acquireSendSlot.',
      labels: ['line_number'],
      buckets: ACQUIRE_SLOT_BUCKETS_SECONDS
    }),
    limitThresholdCrossings: collector.counter('limit_threshold_crossings_total', {
      help: 'Threshold crossings recorded by LimitTracker (warn/limit).',
      labels: ['kind', 'level']
    }),
    bufferJobsTotal: collector.counter('buffer_jobs_total', {
      help: 'Buffer scheduler job lifecycle events.',
      labels: ['event']
    }),
    agentUp: collector.gauge('agent_up', {
      help: 'Always 1 while the process is serving HTTP requests.'
    }),
    agentBuildInfo: collector.gauge('agent_build_info', {
      help: 'Build/version metadata. Always 1; the version is encoded in the label.',
      labels: ['version']
    })
  };
}
