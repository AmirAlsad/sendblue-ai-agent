import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { directConversationKey } from '../../src/conversation/types.js';
import { FakeChatClient, FakeSendblueClient } from '../helpers/fake-clients.js';
import { dispatch } from '../helpers/dispatch.js';
import { loadFixture } from '../helpers/fixtures.js';
import { testConfig } from '../helpers/config.js';

const ADMIN_TOKEN = 'admin-test-token';

function buildApp() {
  const config = testConfig({ adminApiToken: ADMIN_TOKEN });
  const chat = new FakeChatClient();
  chat.nextResponse = { silence: true };
  return createApp({
    config,
    chatClient: chat,
    sendblueClient: new FakeSendblueClient(),
    logger: pino({ level: 'silent' })
  });
}

const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe('/admin introspection routes', () => {
  it('routes are not mounted when ADMIN_API_TOKEN is unset', () => {
    // mountAdminRoutes returns false (no routes registered) when the token is
    // unset. Asserting via a request to the absent route would have to traverse
    // express's 404 path, which trips finalhandler's req.unpipe on the
    // node-mocks-http stub — so we assert the contract directly.
    const config = testConfig();
    const { app } = createApp({
      config,
      chatClient: new FakeChatClient(),
      sendblueClient: new FakeSendblueClient(),
      logger: pino({ level: 'silent' })
    });
    const stack: Array<{ route?: { path?: string } }> = (app as { _router?: { stack: typeof stack } })._router?.stack ?? [];
    const adminPaths = stack.map(layer => layer.route?.path).filter(Boolean) as string[];
    expect(adminPaths.find(p => typeof p === 'string' && p.startsWith('/admin'))).toBeUndefined();
  });

  it('rejects requests with no token (401)', async () => {
    const { app } = buildApp();
    const res = await dispatch(app, {
      method: 'GET',
      path: '/admin/queue'
    });
    expect(res.status).toBe(401);
  });

  it('GET /admin/queue returns scheduler kind and stats', async () => {
    const { app } = buildApp();
    const res = await dispatch(app, {
      method: 'GET',
      path: '/admin/queue',
      headers: auth
    });
    expect(res.status).toBe(200);
    const body = res.body as { kind: string; stats: { pending?: number } };
    expect(body.kind).toBe('in_memory');
    expect(body.stats.pending).toBeGreaterThanOrEqual(0);
  });

  it('GET /admin/conversations/:key redacts content and phone numbers by default', async () => {
    const { app, conversationStore, conversationAgent } = buildApp();
    // Drive a webhook through the agent so a conversation record exists.
    const config = testConfig({ adminApiToken: ADMIN_TOKEN });
    const fixture = loadFixture<Record<string, unknown>>('sendblue/receive-basic.json');
    await dispatch(app, {
      method: 'POST',
      path: '/webhook/receive',
      headers: { [config.sendblueWebhookSecretHeader]: config.sendblueWebhookSecret! },
      body: fixture
    });
    void conversationAgent;
    const lineNumber = (fixture.to_number as string) ?? config.sendblueFromNumber;
    const phoneNumber = fixture.from_number as string;
    const key = directConversationKey(lineNumber, phoneNumber);
    const stored = await conversationStore.getConversation(key);
    expect(stored).toBeDefined();

    const redacted = await dispatch(app, {
      method: 'GET',
      path: `/admin/conversations/${key}`,
      headers: auth
    });
    expect(redacted.status).toBe(200);
    const redactedRecord = (redacted.body as { record: { phoneNumber: string; inboundBuffer: Array<{ content: string }> } }).record;
    expect(redactedRecord.phoneNumber).not.toBe(phoneNumber);
    expect(redactedRecord.phoneNumber).toMatch(/\*+/);
    if (redactedRecord.inboundBuffer.length > 0) {
      expect(redactedRecord.inboundBuffer[0].content).toMatch(/^\[redacted len=/);
    }

    const revealed = await dispatch(app, {
      method: 'GET',
      path: `/admin/conversations/${key}?reveal=true`,
      headers: auth
    });
    expect(revealed.status).toBe(200);
    const revealedRecord = (revealed.body as { record: { phoneNumber: string } }).record;
    expect(revealedRecord.phoneNumber).toBe(phoneNumber);
  });

  it('GET /admin/dedupe?messageHandle= returns present=false for unknown handles', async () => {
    const { app } = buildApp();
    const res = await dispatch(app, {
      method: 'GET',
      path: '/admin/dedupe?messageHandle=does-not-exist',
      headers: auth
    });
    expect(res.status).toBe(200);
    const body = res.body as { messageHandle: string; present: boolean };
    expect(body.present).toBe(false);
  });

  it('GET /admin/status/:messageHandle returns 404 for unknown handles', async () => {
    const { app } = buildApp();
    const res = await dispatch(app, {
      method: 'GET',
      path: '/admin/status/never-sent',
      headers: auth
    });
    expect(res.status).toBe(404);
  });

  it('GET /admin/status/:messageHandle redacts errorMessage/errorDetail by default and reveals on ?reveal=true', async () => {
    const { app } = buildApp();
    const fixture = loadFixture<Record<string, unknown>>('sendblue/status-error.json');
    const messageHandle = fixture.message_handle as string;
    const errorMessage = fixture.error_message as string;
    const errorDetail = fixture.error_detail as string;

    // Drive the status webhook through the route so the InMemoryStatusStore
    // backing /admin/status/:handle is populated for real.
    const statusRes = await dispatch(app, {
      method: 'POST',
      path: '/webhook/status',
      body: fixture
    });
    expect(statusRes.status).toBe(200);

    const redacted = await dispatch(app, {
      method: 'GET',
      path: `/admin/status/${messageHandle}`,
      headers: auth
    });
    expect(redacted.status).toBe(200);
    const redactedRecord = (redacted.body as {
      record: {
        messageHandle: string;
        terminalStatus?: string;
        errorCode?: string;
        errorMessage?: string;
        errorDetail?: string;
        events: Array<{ status: string; errorMessage?: string }>;
      };
    }).record;
    // Status / code / handle structure stays intact:
    expect(redactedRecord.messageHandle).toBe(messageHandle);
    expect(redactedRecord.terminalStatus).toBe('ERROR');
    expect(redactedRecord.errorCode).toBe('5509');
    // ...but error text is masked:
    expect(redactedRecord.errorMessage).toBe(`[redacted len=${errorMessage.length}]`);
    expect(redactedRecord.errorDetail).toBe(`[redacted len=${errorDetail.length}]`);
    expect(redactedRecord.events[0].errorMessage).toBe(`[redacted len=${errorMessage.length}]`);

    const revealed = await dispatch(app, {
      method: 'GET',
      path: `/admin/status/${messageHandle}?reveal=true`,
      headers: auth
    });
    expect(revealed.status).toBe(200);
    const revealedRecord = (revealed.body as {
      record: { errorMessage?: string; errorDetail?: string };
    }).record;
    expect(revealedRecord.errorMessage).toBe(errorMessage);
    expect(revealedRecord.errorDetail).toBe(errorDetail);
  });
});
