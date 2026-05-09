import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { FakeChatClient, FakeSendblueClient } from '../helpers/fake-clients.js';
import { dispatch } from '../helpers/dispatch.js';
import { loadFixture } from '../helpers/fixtures.js';
import { testConfig } from '../helpers/config.js';

type LogEntry = { traceId?: string; conversationTraceId?: string; msg?: string; [k: string]: unknown };

function makeCapturingLogger(): { logger: pino.Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const stream = {
    write(chunk: string) {
      try {
        entries.push(JSON.parse(chunk) as LogEntry);
      } catch {
        // ignore non-JSON lines
      }
    }
  };
  const logger = pino({ level: 'info' }, stream);
  return { logger, entries };
}

describe('trace propagation', () => {
  it('every log line on the receive request carries the same traceId', async () => {
    const { logger, entries } = makeCapturingLogger();
    const config = testConfig();
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      logger
    });

    const fixture = loadFixture<Record<string, unknown>>('sendblue/receive-basic.json');
    const res = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: {
        [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret!,
        'x-trace-id': 'inbound-trace-abc'
      },
      body: fixture
    });
    expect(res.status).toBe(202);

    const tracedEntries = entries.filter(e => e.traceId);
    expect(tracedEntries.length).toBeGreaterThan(0);
    const allEntriesUseInboundTrace = tracedEntries.every(e => e.traceId === 'inbound-trace-abc');
    expect(allEntriesUseInboundTrace).toBe(true);

    // Lock in that the deeper outbound path (sendOutboundAction) carries the
    // traceId — a regression here would mean a log line that's a sibling of
    // the original inbound webhook lost its correlation.
    const outboundLog = entries.find(e => e.msg === 'sending outbound direct message');
    expect(outboundLog).toBeDefined();
    expect(outboundLog?.traceId).toBe('inbound-trace-abc');

    expect(res.headers['x-trace-id']).toBe('inbound-trace-abc');
  });

  it('generates a uuid traceId when none is supplied', async () => {
    const { logger, entries } = makeCapturingLogger();
    const config = testConfig();
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      logger
    });

    const fixture = loadFixture<Record<string, unknown>>('sendblue/receive-basic.json');
    const res = await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: fixture
    });
    expect(res.status).toBe(202);

    const tracedEntries = entries.filter(e => e.traceId);
    expect(tracedEntries.length).toBeGreaterThan(0);
    const distinctTraces = new Set(tracedEntries.map(e => e.traceId));
    expect(distinctTraces.size).toBe(1);
    const generated = [...distinctTraces][0];
    expect(generated).toMatch(/^[A-Za-z0-9._:-]{8,}$/);
    expect(res.headers['x-trace-id']).toBe(generated);
  });

  it('status callback chains conversationTraceId from the prior conversation trace', async () => {
    const { logger, entries } = makeCapturingLogger();
    const config = testConfig();
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      logger
    });

    const fixture = loadFixture<Record<string, unknown>>('sendblue/receive-basic.json');
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: {
        [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret!,
        'x-trace-id': 'conv-trace-xyz'
      },
      body: fixture
    });

    const status = loadFixture<Record<string, unknown>>('sendblue/status-delivered.json');
    // Override the status fixture's message handle to match the FakeSendblue handle.
    const statusBody = { ...status, message_handle: 'sent-1' };
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      body: statusBody
    });

    const statusLogs = entries.filter(e => e.msg === 'status callback received');
    expect(statusLogs.length).toBeGreaterThan(0);
    expect(statusLogs[0].conversationTraceId).toBe('conv-trace-xyz');
  });
});
