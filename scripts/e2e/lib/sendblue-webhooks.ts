import type { E2ESetupEnv } from './env.js';
import {
  DEFAULT_MANAGED_WEBHOOK_TYPES,
  sendblueWebhookPath,
  type SendblueWebhookType
} from '../../../src/sendblue/webhook-types.js';

export type ManagedWebhookType = SendblueWebhookType;

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

type SendblueWebhookValue = string | { url: string; secret?: string };
type SendblueWebhookConfig = Record<string, SendblueWebhookValue[] | string | undefined>;

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

export type WebhookApplyOptions = {
  types?: readonly ManagedWebhookType[];
};

export function desiredWebhooks(
  publicBaseUrl: string,
  secret?: string,
  types: readonly ManagedWebhookType[] = DEFAULT_MANAGED_WEBHOOK_TYPES
): DesiredSendblueWebhook[] {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return types.map(type => ({ type, url: `${base}${sendblueWebhookPath(type)}`, secret }));
}

export function normalizeWebhookList(payload: unknown): SendblueWebhook[] {
  if (Array.isArray(payload)) return payload.filter(isWebhook);
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.webhooks)) return record.webhooks.filter(isWebhook);
    if (Array.isArray(record.data)) return record.data.filter(isWebhook);
    if (typeof record.webhooks === 'object' && record.webhooks !== null) {
      return flattenWebhookConfig(record.webhooks as SendblueWebhookConfig);
    }
  }
  return [];
}

export class SendblueWebhookClient {
  constructor(
    private readonly env: E2ESetupEnv,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async list(): Promise<SendblueWebhook[]> {
    return normalizeWebhookList(await this.listResponse());
  }

  private async listResponse(): Promise<unknown> {
    const response = await this.fetchImpl(this.url('/api/account/webhooks'), {
      headers: this.authHeaders()
    });
    if (!response.ok) {
      throw new Error(await responseError('Sendblue webhook list failed', response));
    }
    return response.json();
  }

  async apply(publicBaseUrl: string, options: WebhookApplyOptions = {}): Promise<WebhookApplyResult[]> {
    const listPayload = await this.listResponse();
    const existing = normalizeWebhookList(listPayload);
    const results: WebhookApplyResult[] = [];
    const desired = desiredWebhooks(publicBaseUrl, this.env.sendblueWebhookSecret, options.types);
    const needsReplace = desired.some(desired => {
      const current = existing.find(webhook => webhookType(webhook) === desired.type);
      return current && (webhookUrl(current) !== desired.url || current.secret !== desired.secret);
    });

    if (needsReplace) {
      const payload = toReplacePayload(listPayload, desired);
      await this.replace(payload);

      return desired.map(desired => {
        const current = existing.find(webhook => webhookType(webhook) === desired.type);
        return {
          type: desired.type,
          action: current ? 'updated' : 'created',
          url: desired.url
        };
      });
    }

    for (const webhook of desired) {
      const current = existing.find(existingWebhook => webhookType(existingWebhook) === webhook.type);

      if (current && webhookUrl(current) === webhook.url && current.secret === webhook.secret) {
        results.push({ type: webhook.type, action: 'unchanged', url: webhook.url });
        continue;
      }

      await this.create(toCreatePayload(webhook));
      results.push({ type: webhook.type, action: 'created', url: webhook.url });
    }

    return results;
  }

  private async create(payload: Record<string, unknown>): Promise<void> {
    const response = await this.fetchImpl(this.url('/api/account/webhooks'), {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(await responseError('Sendblue webhook create failed', response));
  }

  private async replace(payload: Record<string, unknown>): Promise<void> {
    const response = await this.fetchImpl(this.url('/api/account/webhooks'), {
      method: 'PUT',
      headers: this.jsonHeaders(),
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(await responseError('Sendblue webhook replace failed', response));
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

function toCreatePayload(webhook: DesiredSendblueWebhook): Record<string, unknown> {
  return {
    webhooks: [toWebhookValue(webhook)],
    type: webhook.type
  };
}

function toReplacePayload(payload: unknown, desired: DesiredSendblueWebhook[]): Record<string, unknown> {
  const config = webhookConfigFromPayload(payload);

  for (const webhook of desired) {
    config[webhook.type] = [toWebhookValue(webhook)];
  }

  return { webhooks: config };
}

function toWebhookValue(webhook: DesiredSendblueWebhook): SendblueWebhookValue {
  if (!webhook.secret) return webhook.url;
  return {
    url: webhook.url,
    secret: webhook.secret
  };
}

function webhookConfigFromPayload(payload: unknown): SendblueWebhookConfig {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record.webhooks === 'object' && record.webhooks !== null && !Array.isArray(record.webhooks)) {
      return { ...(record.webhooks as SendblueWebhookConfig) };
    }
  }

  return normalizeWebhookList(payload).reduce<SendblueWebhookConfig>((config, webhook) => {
    const type = webhookType(webhook);
    const url = webhookUrl(webhook);
    if (!type || !url) return config;
    config[type] = [
      ...webhookValuesFor(config, type),
      webhook.secret ? { url, secret: webhook.secret } : url
    ];
    return config;
  }, {});
}

function webhookValuesFor(config: SendblueWebhookConfig, type: string): SendblueWebhookValue[] {
  const existing = config[type];
  return Array.isArray(existing) ? existing.filter(isWebhookValue) : [];
}

function flattenWebhookConfig(config: SendblueWebhookConfig): SendblueWebhook[] {
  return Object.entries(config).flatMap(([type, values]) => {
    if (type === 'globalSecret' || !Array.isArray(values)) return [];
    return values.flatMap(value => {
      if (typeof value === 'string') {
        return { type, url: value };
      }
      if (isWebhookValue(value)) {
        return {
          ...value,
          type,
          url: value.url
        };
      }
      return [];
    });
  });
}

function isWebhookValue(value: unknown): value is SendblueWebhookValue {
  return (
    typeof value === 'string' ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as Record<string, unknown>).url === 'string')
  );
}

async function responseError(label: string, response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const suffix = body.trim() ? `: ${body.trim()}` : '';
  return `${label} with HTTP ${response.status}${suffix}`;
}

function isWebhook(value: unknown): value is SendblueWebhook {
  return typeof value === 'object' && value !== null;
}
