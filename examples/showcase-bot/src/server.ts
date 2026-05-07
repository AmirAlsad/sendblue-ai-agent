import 'dotenv/config';
import express from 'express';
import { loadConfig } from './config.js';
import { runTurn, type InboundMessage } from './llm.js';
import { log } from './logger.js';

const config = loadConfig();
const app = express();
app.use(express.json({ limit: '5mb' }));

interface IncomingChatRequest {
  message?: string;
  fromNumber?: string;
  toNumber?: string;
  messageHandle?: string;
  channel?: string;
  messages?: Array<{
    content?: string;
    fromNumber?: string;
    messageHandle?: string;
    channel?: string;
    mediaUrl?: string | null;
    messageType?: string | null;
  }>;
  conversation?: {
    key?: string;
    type?: 'direct' | 'group';
    channel?: string;
    smsDowngraded?: boolean;
    invocation?: { reason?: 'direct' | 'name' | 'reaction' | 'reply' };
  };
  identity?: { userId?: string; data?: Record<string, unknown> } | null;
  sendblue?: { wasDowngraded?: boolean; mediaUrl?: string | null; messageType?: string | null };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'showcase-bot', model: config.model });
});

app.post('/chat', async (req, res) => {
  const body = (req.body || {}) as IncomingChatRequest;
  const conversationKey =
    body.conversation?.key ||
    `fallback:${body.toNumber || 'line'}:${body.fromNumber || 'unknown'}`;

  // Defer to the transport's group rules. The transport routes any group
  // message to us, but we only respond when the user explicitly addressed
  // the agent (`invocation.reason === 'name'`). Otherwise stay silent.
  const isGroup = body.conversation?.type === 'group';
  if (isGroup && body.conversation?.invocation?.reason !== 'name') {
    log('info', 'group message not addressed — silent', { conversationKey });
    return res.json({ silence: true });
  }

  const inboundMessages = collectInboundMessages(body);
  if (inboundMessages.length === 0) {
    log('warn', 'no inbound message content', { conversationKey });
    return res.json({ silence: true });
  }

  const channel = body.conversation?.channel || body.channel || 'unknown';
  const wasDowngraded = Boolean(body.conversation?.smsDowngraded || body.sendblue?.wasDowngraded);
  const identityLabel = formatIdentityLabel(body.identity);

  log('info', 'turn starting', {
    conversationKey,
    channel,
    wasDowngraded,
    inboundCount: inboundMessages.length,
    hasMedia: inboundMessages.some(m => m.mediaUrl && m.mediaType),
    identityLabel
  });

  try {
    const result = await runTurn(config, {
      conversationKey,
      channel,
      wasDowngraded,
      ...(identityLabel ? { identityLabel } : {}),
      inboundMessages
    });

    log('info', 'turn complete', {
      conversationKey,
      latencyMs: result.latencyMs,
      actionTypes: result.actions.map(a => a.type),
      silent: result.silent,
      usage: result.usage
    });

    if (result.silent || result.actions.length === 0) {
      return res.json({ silence: true });
    }
    return res.json({ actions: result.actions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `LLM error: ${message}`, { conversationKey });
    return res.status(502).json({ error: `LLM request failed: ${message}` });
  }
});

function collectInboundMessages(body: IncomingChatRequest): InboundMessage[] {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages
      .map(m => ({
        handle: m.messageHandle || body.messageHandle || '',
        text: typeof m.content === 'string' ? m.content : '',
        channel: m.channel || body.channel || 'unknown',
        mediaUrl: m.mediaUrl ?? null,
        mediaType: m.messageType ?? null
      }))
      .filter(m => m.handle && (m.text.length > 0 || m.mediaUrl));
  }
  if (body.message || body.sendblue?.mediaUrl) {
    return [
      {
        handle: body.messageHandle || '',
        text: typeof body.message === 'string' ? body.message : '',
        channel: body.channel || 'unknown',
        mediaUrl: body.sendblue?.mediaUrl ?? null,
        mediaType: body.sendblue?.messageType ?? null
      }
    ].filter(m => m.handle && (m.text.length > 0 || m.mediaUrl));
  }
  return [];
}

function formatIdentityLabel(identity?: IncomingChatRequest['identity']): string | undefined {
  if (!identity) return undefined;
  const data = identity.data as Record<string, unknown> | undefined;
  const name = typeof data?.name === 'string' ? data.name : undefined;
  if (name) return identity.userId ? `${name} (${identity.userId})` : name;
  return identity.userId;
}

app.listen(config.port, () => {
  log('info', `showcase-bot listening on http://localhost:${config.port}/chat`, {
    model: config.model
  });
  log('info', `set CHAT_ENDPOINT_URL=http://localhost:${config.port}/chat`);
});
