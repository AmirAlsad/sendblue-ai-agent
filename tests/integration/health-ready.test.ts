import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { InMemoryBufferScheduler, type BufferScheduler } from '../../src/conversation/scheduler.js';
import { FakeChatClient, FakeSendblueClient } from '../helpers/fake-clients.js';
import { dispatch } from '../helpers/dispatch.js';
import { testConfig } from '../helpers/config.js';

describe('/health and /ready', () => {
  it('GET /health responds with uptime and version, no auth required', async () => {
    const config = testConfig();
    const { app } = createApp({ config, chatClient: new FakeChatClient(), sendblueClient: new FakeSendblueClient() });
    const res = await dispatch(app, { method: 'GET', path: '/health' });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; uptime_s: number; version: string; node_version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.uptime_s).toBe('number');
    expect(typeof body.version).toBe('string');
    expect(typeof body.node_version).toBe('string');
  });

  it('GET /ready reports in_memory scheduler when no Redis is configured', async () => {
    const config = testConfig();
    const { app } = createApp({ config, chatClient: new FakeChatClient(), sendblueClient: new FakeSendblueClient() });
    const res = await dispatch(app, { method: 'GET', path: '/ready' });
    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      redis: { ok: boolean; kind: string };
      scheduler: { ok: boolean; kind: string };
    };
    expect(body.ok).toBe(true);
    expect(body.redis.kind).toBe('in_memory');
    expect(body.scheduler.kind).toBe('in_memory');
  });

  it('GET /ready returns 503 when the scheduler.getStats throws', async () => {
    const config = testConfig();
    const failingScheduler: BufferScheduler = new InMemoryBufferScheduler();
    failingScheduler.getStats = async () => {
      throw new Error('boom');
    };
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      bufferScheduler: failingScheduler,
      logger: pino({ level: 'silent' })
    });
    const res = await dispatch(app, { method: 'GET', path: '/ready' });
    expect(res.status).toBe(503);
    const body = res.body as { ok: boolean; scheduler: { ok: boolean; error: string } };
    expect(body.ok).toBe(false);
    expect(body.scheduler.ok).toBe(false);
    expect(body.scheduler.error).toContain('boom');
  });
});
