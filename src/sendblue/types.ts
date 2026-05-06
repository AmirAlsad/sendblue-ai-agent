export const SENDBLUE_STATUSES = [
  'REGISTERED',
  'PENDING',
  'DECLINED',
  'QUEUED',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'ERROR'
] as const;

export type SendblueStatus = (typeof SENDBLUE_STATUSES)[number];

export type SendblueReceiveStatus = SendblueStatus | 'RECEIVED';

export const SENDBLUE_SEND_STYLES = [
  'celebration',
  'shooting_star',
  'fireworks',
  'lasers',
  'love',
  'confetti',
  'balloons',
  'spotlight',
  'echo',
  'invisible',
  'gentle',
  'loud',
  'slam'
] as const;

export type SendblueSendStyle = (typeof SENDBLUE_SEND_STYLES)[number];

export const SENDBLUE_REACTIONS = [
  'love',
  'like',
  'dislike',
  'laugh',
  'emphasize',
  'question'
] as const;

export type SendblueReaction = (typeof SENDBLUE_REACTIONS)[number];

export const SENDBLUE_ERROR_CODES = [
  '4000',
  '4001',
  '4002',
  '5000',
  '5003',
  '5509',
  '10001',
  '10002',
  'SMS_LIMIT_REACHED'
] as const;

export type SendblueErrorCode = (typeof SENDBLUE_ERROR_CODES)[number];

export type SendblueReceiveWebhook = {
  content: string;
  fromNumber: string;
  toNumber: string;
  messageHandle: string;
  isOutbound: boolean;
  status?: SendblueReceiveStatus;
  wasDowngraded: boolean | null;
  service?: string;
  mediaUrl?: string | null;
  groupId?: string | null;
  groupDisplayName?: string | null;
  sendblueNumber?: string | null;
  participants?: unknown;
  sendStyle?: string | null;
  messageType?: string | null;
  raw: Record<string, unknown>;
};

export type SendblueStatusWebhook = {
  messageHandle: string;
  status: SendblueStatus;
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
  wasDowngraded?: boolean | null;
  service?: string;
  raw: Record<string, unknown>;
};

export type SendblueOperationalWebhook = {
  raw: Record<string, unknown>;
  messageHandle?: string;
  fromNumber?: string;
  toNumber?: string;
  number?: string;
  status?: string;
  content?: string;
};

export type SendblueOutboundMessage = {
  toNumber: string;
  content: string;
  statusCallback: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
};

export type SendblueOutboundGroupMessage = {
  groupId: string;
  content: string;
  statusCallback?: string;
  mediaUrl?: string;
  sendStyle?: SendblueSendStyle;
};

export type SendblueReactionRequest = {
  messageHandle: string;
  reaction: SendblueReaction;
  partIndex?: number;
};

export type SendblueMarkReadRequest = {
  toNumber: string;
};

export type SendblueTypingIndicator = {
  toNumber: string;
};

export type SendblueTypingIndicatorResult = {
  status?: string;
  errorMessage?: string | null;
  raw: unknown;
};

export type SendblueSendResult = {
  messageHandle?: string;
  raw: unknown;
};

export type SendblueActionResult = {
  status?: string;
  message?: string;
  errorCode?: string;
  errorMessage?: string | null;
  messageHandle?: string;
  reaction?: string;
  number?: string;
  raw: unknown;
};
