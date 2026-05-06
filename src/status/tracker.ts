import type { SendblueStatus, SendblueStatusWebhook } from '../sendblue/types.js';

export type StatusRecord = {
  messageHandle: string;
  history: SendblueStatus[];
  terminalStatus?: SendblueStatus;
  errorCode?: string;
  errorMessage?: string;
  errorDetail?: string;
};

export const TERMINAL_STATUSES = new Set<SendblueStatus>(['DELIVERED', 'DECLINED', 'ERROR']);

export function createStatusRecord(messageHandle: string): StatusRecord {
  return {
    messageHandle,
    history: []
  };
}

export function applyStatusUpdate(
  existing: StatusRecord | undefined,
  update: SendblueStatusWebhook
): StatusRecord {
  const record = existing ? { ...existing, history: [...existing.history] } : createStatusRecord(update.messageHandle);

  if (record.history.at(-1) !== update.status) {
    record.history.push(update.status);
  }

  if (TERMINAL_STATUSES.has(update.status)) {
    record.terminalStatus = update.status;
  }

  if (update.status === 'ERROR') {
    record.errorCode = update.errorCode;
    record.errorMessage = update.errorMessage;
    record.errorDetail = update.errorDetail;
  }

  return record;
}

export class InMemoryStatusStore {
  private readonly records = new Map<string, StatusRecord>();

  apply(update: SendblueStatusWebhook): StatusRecord {
    const next = applyStatusUpdate(this.records.get(update.messageHandle), update);
    this.records.set(update.messageHandle, next);
    return next;
  }

  get(messageHandle: string): StatusRecord | undefined {
    return this.records.get(messageHandle);
  }

  all(): StatusRecord[] {
    return Array.from(this.records.values());
  }

  clear(): void {
    this.records.clear();
  }
}
