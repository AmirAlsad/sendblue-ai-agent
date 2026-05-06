import type { E2ESetupEnv } from './env.js';

export type ManagedWebhookType = 'receive' | 'outbound';

export type SendblueWebhook = {
  id?: string;
  type?: string;
  webhook_type?: string;
  event_type?: string;
  url?: string;
  endpoint?: string;
  secret?: string;
  globalSecret?: string;
};

export type DesiredSendblueWebhook = {
  type: ManagedWebhookType;
  url: string;
  secret?: string;
};

export type WebhookApplyResult = {
  type: ManagedWebhookType;
  action: 'created' | 'updated' | 'unchanged';
  url: string;
};

export function desiredWebhooks(publicBaseUrl: string, secret?: string): DesiredSendblueWebhook[] {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return [
    { type: 'receive', url: `${base}/webhook/receive`, secret },
    { type: 'outbound', url: `${base}/webhook/status`, secret }
  ];
}

export function normalizeWebhookList(payload: unknown): SendblueWebhook[] {
  if (Array.isArray(payload)) return payload.filter(isWebhook);
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.webhooks)) return record.webhooks.filter(isWebhook);
    if (Array.isArray(record.data)) return record.data.filter(isWebhook);
  }
  return [];
}

export class SendblueWebhookClient {
  constructor(
    private readonly env: E2ESetupEnv,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async list(): Promise<SendblueWebhook[]> {
    const response = await this.fetchImpl(this.url('/api/account/webhooks'), {
      headers: this.authHeaders()
    });
    if (!response.ok) {
      throw new Error(`Sendblue webhook list failed with HTTP ${response.status}`);
    }
    return normalizeWebhookList(await response.json());
  }

  async apply(publicBaseUrl: string): Promise<WebhookApplyResult[]> {
    const existing = await this.list();
    const results: WebhookApplyResult[] = [];

    for (const desired of desiredWebhooks(publicBaseUrl, this.env.sendblueWebhookSecret)) {
      const current = existing.find(webhook => webhookType(webhook) === desired.type);
      const payload = toSendbluePayload(desired);

      if (current && webhookUrl(current) === desired.url && current.secret === desired.secret) {
        results.push({ type: desired.type, action: 'unchanged', url: desired.url });
        continue;
      }

      if (current) {
        await this.update(current, payload);
        results.push({ type: desired.type, action: 'updated', url: desired.url });
      } else {
        await this.create(payload);
        results.push({ type: desired.type, action: 'created', url: desired.url });
      }
    }

    return results;
  }

  private async create(payload: Record<string, unknown>): Promise<void> {
    const response = await this.fetchImpl(this.url('/api/account/webhooks'), {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Sendblue webhook create failed with HTTP ${response.status}`);
  }

  private async update(webhook: SendblueWebhook, payload: Record<string, unknown>): Promise<void> {
    const path = webhook.id ? `/api/account/webhooks/${encodeURIComponent(webhook.id)}` : '/api/account/webhooks';
    const response = await this.fetchImpl(this.url(path), {
      method: 'PUT',
      headers: this.jsonHeaders(),
      body: JSON.stringify({ id: webhook.id, ...payload })
    });
    if (!response.ok) throw new Error(`Sendblue webhook update failed with HTTP ${response.status}`);
  }

  private url(path: string): string {
    return `${this.env.sendblueApiBaseUrl}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      'sb-api-key-id': this.env.sendblueApiKeyId ?? '',
      'sb-api-secret-key': this.env.sendblueApiSecretKey ?? ''
    };
  }

  private jsonHeaders(): Record<string, string> {
    return {
      ...this.authHeaders(),
      'content-type': 'application/json'
    };
  }
}

export function webhookType(webhook: SendblueWebhook): string | undefined {
  return webhook.type || webhook.webhook_type || webhook.event_type;
}

export function webhookUrl(webhook: SendblueWebhook): string | undefined {
  return webhook.url || webhook.endpoint;
}

function toSendbluePayload(webhook: DesiredSendblueWebhook): Record<string, unknown> {
  return {
    type: webhook.type,
    webhook_type: webhook.type,
    event_type: webhook.type,
    url: webhook.url,
    secret: webhook.secret
  };
}

function isWebhook(value: unknown): value is SendblueWebhook {
  return typeof value === 'object' && value !== null;
}
