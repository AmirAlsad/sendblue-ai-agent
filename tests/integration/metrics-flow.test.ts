import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { InMemoryMetricsCollector, type MetricsSnapshot } from '../../src/metrics/collector.js';
import { FakeChatClient, FakeSendblueClient } from '../helpers/fake-clients.js';
import { dispatch } from '../helpers/dispatch.js';
import { loadFixture } from '../helpers/fixtures.js';
import { testConfig } from '../helpers/config.js';

const ADMIN_TOKEN = 'metrics-test-token';

function findCounterValue(
  snap: MetricsSnapshot,
  name: string,
  matcher: (labels: Record<string, string>) => boolean
): number {
  const metric = snap.metrics.find(m => m.name === name);
  if (!metric || metric.kind !== 'counter') return 0;
  const series = metric.series.find(s => matcher(s.labels));
  return series ? (series as { value: number }).value : 0;
}

function findHistogramCount(
  snap: MetricsSnapshot,
  name: string,
  matcher: (labels: Record<string, string>) => boolean
): number {
  const metric = snap.metrics.find(m => m.name === name);
  if (!metric || metric.kind !== 'histogram') return 0;
  const series = metric.series.find(s => matcher(s.labels));
  return series ? (series as { count: number }).count : 0;
}

describe('metrics flow', () => {
  it('records webhook, dedupe, chat, and outbound metrics on the receive→send happy path', async () => {
    const collector = new InMemoryMetricsCollector();
    const config = testConfig({ adminApiToken: ADMIN_TOKEN });
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      metrics: collector,
      logger: pino({ level: 'silent' })
    });

    const fixture = loadFixture<Record<string, unknown>>('sendblue/receive-basic.json');
    const res = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: fixture
    });
    expect(res.status).toBe(202);

    const snap = collector.snapshot();
    expect(
      findCounterValue(snap, 'webhook_received_total', l => l.type === 'receive' && l.result === 'accepted')
    ).toBe(1);
    expect(
      findCounterValue(snap, 'webhook_dedupe_total', l => l.result === 'miss')
    ).toBe(1);
    expect(
      findHistogramCount(snap, 'chat_dispatch_duration_seconds', l => l.result === 'success')
    ).toBe(1);
    expect(
      findCounterValue(snap, 'outbound_send_total', l => l.operation === 'message' && l.result === 'success')
    ).toBe(1);
    expect(
      findHistogramCount(snap, 'outbound_send_duration_seconds', l => l.operation === 'message' && l.result === 'success')
    ).toBe(1);
  });

  it('records webhook_dedupe_total{result="hit"} on duplicate inbound', async () => {
    const collector = new InMemoryMetricsCollector();
    const config = testConfig({ adminApiToken: ADMIN_TOKEN });
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      metrics: collector,
      logger: pino({ level: 'silent' })
    });

    const fixture = loadFixture<Record<string, unknown>>('sendblue/receive-basic.json');
    const headers = { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! };
    await dispatch(app, { method: 'POST', path: '/webhook/receive', headers, body: fixture });
    await dispatch(app, { method: 'POST', path: '/webhook/receive', headers, body: fixture });

    const snap = collector.snapshot();
    expect(findCounterValue(snap, 'webhook_dedupe_total', l => l.result === 'hit')).toBe(1);
  });

  it('GET /metrics returns prometheus text when ADMIN_API_TOKEN is set', async () => {
    const collector = new InMemoryMetricsCollector();
    const config = testConfig({ adminApiToken: ADMIN_TOKEN });
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      metrics: collector,
      logger: pino({ level: 'silent' })
    });
    const res = await dispatch(app, {
      method: 'GET',
      path: '/metrics',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(res.status).toBe(200);
    expect(typeof res.text).toBe('string');
    expect(res.text).toContain('# TYPE agent_up gauge');
    expect(res.text).toContain('agent_up 1');
    expect(res.text).toContain('# TYPE webhook_received_total counter');
  });

  it('GET /metrics rejects unauthenticated requests with 401', async () => {
    const config = testConfig({ adminApiToken: ADMIN_TOKEN });
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      metrics: new InMemoryMetricsCollector(),
      logger: pino({ level: 'silent' })
    });
    const res = await dispatch(app, { method: 'GET', path: '/metrics' });
    expect(res.status).toBe(401);
  });
});
