export const SENDBLUE_WEBHOOK_TYPES = [
  'receive',
  'outbound',
  'typing_indicator',
  'call_log',
  'line_blocked',
  'line_assigned',
  'contact_created'
] as const;

export type SendblueWebhookType = (typeof SENDBLUE_WEBHOOK_TYPES)[number];

export const DEFAULT_MANAGED_WEBHOOK_TYPES: readonly SendblueWebhookType[] = ['receive', 'outbound'];
export const CAPTURE_MANAGED_WEBHOOK_TYPES: readonly SendblueWebhookType[] = SENDBLUE_WEBHOOK_TYPES;

export function sendblueWebhookPath(type: SendblueWebhookType): string {
  switch (type) {
    case 'receive':
      return '/webhook/receive';
    case 'outbound':
      return '/webhook/status';
    case 'typing_indicator':
      return '/webhook/typing-indicator';
    case 'call_log':
      return '/webhook/call-log';
    case 'line_blocked':
      return '/webhook/line-blocked';
    case 'line_assigned':
      return '/webhook/line-assigned';
    case 'contact_created':
      return '/webhook/contact-created';
  }
}

export function sendblueOperationalWebhookTypeFromPath(path: string): SendblueWebhookType | undefined {
  return SENDBLUE_WEBHOOK_TYPES.find(type => sendblueWebhookPath(type) === path);
}
