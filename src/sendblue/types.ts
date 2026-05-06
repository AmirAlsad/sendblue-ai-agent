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
  status?: SendblueStatus;
  wasDowngraded: boolean | null;
  service?: string;
  mediaUrl?: string | null;
  groupId?: string | null;
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
  raw: Record<string, unknown>;
};

export type SendblueOutboundMessage = {
  toNumber: string;
  content: string;
  statusCallback: string;
};

export type SendblueSendResult = {
  messageHandle?: string;
  raw: unknown;
};
