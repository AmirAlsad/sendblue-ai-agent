import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import type { ChatEndpointRequest, ChatEndpointResponse } from '../../../src/chat/types.js';
import type { ObservedWebhookEnvelope } from '../../../src/http/app.js';
import type { SendblueClient } from '../../../src/sendblue/client.js';
import type {
  SendblueActionResult,
  SendblueContactRequest,
  SendblueContactResult,
  SendblueMarkReadRequest,
  SendblueOutboundGroupMessage,
  SendblueOutboundMessage,
  SendblueReactionRequest,
  SendblueSendResult,
  SendblueTypingIndicator,
  SendblueTypingIndicatorResult
} from '../../../src/sendblue/types.js';

export type ShowcaseScenario = {
  id: string;
  title: string;
  instruction: string;
  expectedReceiveCount: number;
  expectedChatMessageCount?: number;
  expectedOutboundMessageCount?: number;
  optional?: boolean;
  settleMs?: number;
};

export type ShowcasePromptOptions = {
  scenario: ShowcaseScenario;
  sessionId: string;
  index: number;
  total: number;
};

export type ShowcaseChatOptions = {
  mediaUrl?: string;
  agentDisplayName?: string;
  readTypingDelayMs?: number;
  currentScenarioId?: () => string | undefined;
  scenarioForRequest?: (request: ChatEndpointRequest) => string | undefined;
  typingWebhookAvailable?: () => boolean | undefined;
};

export type StartedShowcaseChatEndpoint = {
  url: string;
  exchanges: ShowcaseChatExchange[];
  close(): Promise<void>;
};

export type ShowcaseChatExchange = {
  at: string;
  scenarioId?: string;
  messageCount: number;
  understood: string;
  request: ChatEndpointRequest;
  response: ChatEndpointResponse;
};

export type ShowcaseCaptureEnvelope = ObservedWebhookEnvelope & {
  sequence: number;
  capture?: Record<string, unknown>;
};

export type ShowcaseCaptureSink = {
  outputDir: string;
  envelopes: ShowcaseCaptureEnvelope[];
  record(envelope: ObservedWebhookEnvelope, metadata?: Record<string, unknown>): Promise<void>;
};

export type ShowcaseSendblueCall = {
  kind: 'message' | 'group-message' | 'reaction' | 'read-receipt' | 'typing-indicator' | 'create-contact';
  at: string;
  payload: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
};

export type ShowcaseStepSummary = {
  scenarioId: string;
  title: string;
  skipped: boolean;
  matched: boolean;
  receiveCount: number;
  statusCount: number;
  typingCount: number;
  typingSucceededCount: number;
  typingFailedCount: number;
  readReceiptCount: number;
  readReceiptSucceededCount: number;
  readReceiptFailedCount: number;
  reactionCount: number;
  messageCount: number;
  groupMessageCount: number;
  inboundTypingWebhookCount: number;
  chatRequestCount: number;
  maxBufferedMessageCount: number;
  understood?: string;
};

export const showcaseScenarios: ShowcaseScenario[] = [
  {
    id: 'basic-text',
    title: 'Basic text echo',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    instruction: 'Send me one short sentence. I will echo the exact text I understood.'
  },
  {
    id: 'burst-buffer',
    title: 'Rapid message buffering',
    expectedReceiveCount: 2,
    expectedChatMessageCount: 2,
    expectedOutboundMessageCount: 2,
    instruction:
      'Send two or three separate short texts back-to-back. Do not wait for my response between them. I will wait for a quiet window, combine them, and repeat them in order.'
  },
  {
    id: 'tapback-heart',
    title: 'Heart Tapback understanding',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    instruction: 'React to this bubble with a heart Tapback. Do not send a separate text reply.'
  },
  {
    id: 'tapback-custom',
    title: 'Custom Tapback understanding',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    optional: true,
    instruction:
      'React to this bubble with a non-standard emoji Tapback. Do not send a separate text reply.'
  },
  {
    id: 'inbound-media',
    title: 'Inbound media handling',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    instruction: 'Send one image or attachment. I will report the media URL and any caption Sendblue provides.'
  },
  {
    id: 'outbound-media',
    title: 'Outbound hosted media',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    optional: true,
    instruction:
      'Reply "outbound media". I will send a hosted media message if SHOWCASE_MEDIA_URL is configured; otherwise I will explain the skip.'
  },
  {
    id: 'send-effect',
    title: 'iMessage send effect',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    instruction: 'Reply "effect". I will request an iMessage send effect on the response.'
  },
  {
    id: 'contextual-reply',
    title: 'Reply intent fallback',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    instruction:
      'Reply "reply". I will show that reply intent is preserved in the chat contract, then sent as a normal Sendblue message because Sendblue does not provide a native direct-reply send API.'
  },
  {
    id: 'xml-compat',
    title: 'XML tag parser compatibility',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    instruction:
      'Reply "xml". I will intentionally have the local chat endpoint return XML-like tags instead of JSON actions; the agent will parse those tags into the same Sendblue action model and request a send effect.'
  },
  {
    id: 'read-typing',
    title: 'Read receipts and typing refresh',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    settleMs: 8000,
    instruction:
      'Reply "read typing". I will pause for a noticeably long processing window, repeatedly call the outbound typing API, call the mark-read API, and then summarize those local API calls.'
  },
  {
    id: 'inbound-typing',
    title: 'Inbound typing webhook state',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    optional: true,
    instruction:
      'Open the reply composer and type for a few seconds without sending. Then send "inbound typing". If this Sendblue account could not register the typing_indicator webhook, I will say that plainly instead of implying your typing was missed locally.'
  },
  {
    id: 'addressed-group',
    title: 'Addressed group routing',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    optional: true,
    instruction:
      'From a group thread that includes the Sendblue line, send a message mentioning the configured agent display name.'
  },
  {
    id: 'sms-fallback',
    title: 'SMS fallback suppression',
    expectedReceiveCount: 1,
    expectedOutboundMessageCount: 1,
    optional: true,
    instruction: 'From a non-iMessage sender, or with iMessage disabled, send any SMS to the Sendblue line.'
  }
];

export function showcaseToken(sessionId: string, scenarioId: string): string {
  return `[sendblue-showcase:${sessionId}:${scenarioId}]`;
}

export function formatShowcasePrompt(options: ShowcasePromptOptions): string {
  const optional = options.scenario.optional ? ' Optional step.' : '';

  return [
    `Showcase step ${options.index}/${options.total}: ${options.scenario.title}.${optional}`,
    options.scenario.instruction,
    'Reply "skip" if you want to move past this step.'
  ].join('\n');
}

export function selectShowcaseScenarios(args: string[]): ShowcaseScenario[] {
  if (args.includes('--list')) {
    return [];
  }

  const only = readArg(args, '--only');
  if (!only) return showcaseScenarios;

  const ids = only
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error('No showcase scenarios selected.');

  const byId = new Map(showcaseScenarios.map(scenario => [scenario.id, scenario]));
  const unknown = ids.filter(id => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown showcase scenario(s): ${unknown.join(', ')}. Run npm run showcase:e2e -- --list.`);
  }

  return ids.map(id => byId.get(id)!);
}

export function listShowcaseScenarios(): string[] {
  return showcaseScenarios.map(scenario => {
    const optional = scenario.optional ? ' (optional)' : '';
    return `${scenario.id}${optional}: ${scenario.title}`;
  });
}

export async function startShowcaseChatEndpoint(
  options: ShowcaseChatOptions = {}
): Promise<StartedShowcaseChatEndpoint> {
  const exchanges: ShowcaseChatExchange[] = [];
  const app = createShowcaseChatApp(options);
  app.locals.showcaseExchanges = exchanges;
  const server = await listen(app, 0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/chat`,
    exchanges,
    close: () => closeServer(server)
  };
}

export function createShowcaseChatApp(options: ShowcaseChatOptions = {}): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'showcase-chat-endpoint' });
  });

  app.post('/chat', async (req, res) => {
    const request = req.body as ChatEndpointRequest;
    const scenarioId =
      findScenarioId(request) ?? options.scenarioForRequest?.(request) ?? options.currentScenarioId?.();
    const delayMs = scenarioId === 'read-typing' ? options.readTypingDelayMs ?? 3500 : 0;
    if (delayMs > 0) await delay(delayMs);
    const response = showcaseChatResponse(request, options, scenarioId);
    const exchanges = Array.isArray(app.locals.showcaseExchanges)
      ? (app.locals.showcaseExchanges as ShowcaseChatExchange[])
      : undefined;
    exchanges?.push({
      at: new Date().toISOString(),
      scenarioId,
      messageCount: Array.isArray(request.messages) && request.messages.length > 0 ? request.messages.length : 1,
      understood: summarizeUnderstanding(request),
      request,
      response
    });
    res.json(response);
  });

  return app;
}

export function showcaseChatResponse(
  request: ChatEndpointRequest,
  options: ShowcaseChatOptions = {},
  scenarioId = findScenarioId(request) ?? options.currentScenarioId?.()
): ChatEndpointResponse {
  const messages = Array.isArray(request.messages) && request.messages.length > 0 ? request.messages : [];
  const understood = summarizeUnderstanding(request);
  const target = latestTarget(request);

  if (isSkipContent(understood)) {
    return { silence: true };
  }

  switch (scenarioId) {
    case 'burst-buffer':
      return {
        actions: [
          {
            type: 'message',
            content:
              messages.length >= 2
                ? `Buffer verified: I received ${messages.length} messages in order: ${joinedContents(request)}`
                : `Buffer incomplete: I only received ${messages.length || 1} message before processing: ${joinedContents(request)}`
          },
          {
            type: 'message',
            content: 'Ordered outbound delivery is now sending this second verification message after the first.'
          }
        ]
      };
    case 'tapback-heart':
    case 'tapback-custom':
      return {
        actions: [
          {
            type: 'message',
            content: `Tapback understood: ${understood}`
          }
        ]
      };
    case 'inbound-media':
      return {
        actions: [
          {
            type: 'message',
            content: `Media understood: ${request.sendblue.mediaUrl ? `received ${request.sendblue.mediaUrl}` : understood}`
          }
        ]
      };
    case 'outbound-media':
      return options.mediaUrl
        ? {
            actions: [
              { type: 'message', content: `Outbound media request understood: ${understood}` },
              { type: 'media', content: 'Hosted media from the showcase endpoint.', mediaUrl: options.mediaUrl }
            ]
          }
        : {
            actions: [
              {
                type: 'message',
                content:
                  'Outbound media request understood, but SHOWCASE_MEDIA_URL is not configured, so hosted media send was skipped.'
              }
            ]
          };
    case 'send-effect':
      return {
        actions: [
          {
            type: 'message',
            content: `Effect request understood: ${understood}`,
            sendStyle: isSmsLike(request) ? undefined : 'celebration'
          }
        ]
      };
    case 'contextual-reply':
      return {
        actions: [
          {
            type: 'reply',
            target,
            content: `Reply intent captured for ${targetDescription(target)}. Sendblue direct sends do not create native reply bubbles, so this is delivered as a normal message. Understood: ${understood}`
          }
        ]
      };
    case 'xml-compat':
      return {
        message: `<message send_style="balloons">XML compatibility demo: the chat endpoint returned a legacy string containing a message tag with send_style=&quot;balloons&quot;. The agent parsed that XML-like tag into a normal Sendblue action. I understood: ${escapeXml(understood)}.</message>`
      };
    case 'read-typing':
      return {
        actions: [
          {
            type: 'message',
            content: `Read receipt and typing showcase understood: ${understood}`
          }
        ]
      };
    case 'inbound-typing':
      return {
        actions: [
          {
            type: 'message',
            content:
              options.typingWebhookAvailable?.() === false
                ? `Inbound typing could not be observed because this Sendblue account did not persist the typing_indicator webhook registration. Your message still arrived normally: ${understood}`
                : request.typing
                  ? `Inbound typing understood: isTyping=${request.typing.isTyping} receivedAt=${request.typing.receivedAt}. Message: ${understood}`
                  : `Inbound typing step received, but no typing webhook state was present before your message. Message: ${understood}`
          }
        ]
      };
    case 'addressed-group':
      return {
        actions: [
          {
            type: 'message',
            content:
              request.conversation?.type === 'group'
                ? `Addressed group understood by ${options.agentDisplayName ?? 'sb-agent'}: ${understood}`
                : `Group step received outside a group: ${understood}`
          }
        ]
      };
    case 'sms-fallback':
      return {
        actions: [
          {
            type: 'message',
            content: isSmsLike(request)
              ? `SMS fallback understood and rich iMessage-only actions are suppressed: ${understood}`
              : `SMS fallback step received on ${request.channel}: ${understood}`
          }
        ]
      };
    case 'basic-text':
    default:
      return {
        actions: [
          {
            type: 'message',
            content: `Text understood: ${understood}`
          }
        ]
      };
  }
}

export function summarizeUnderstanding(request: ChatEndpointRequest): string {
  const text = joinedContents(request);
  const stripped = stripShowcaseTokens(text).trim();
  if (stripped) return stripped;
  if (request.sendblue.mediaUrl) return `media at ${request.sendblue.mediaUrl}`;
  return request.message || 'empty message';
}

export function findScenarioId(request: Pick<ChatEndpointRequest, 'message' | 'messages'>): string | undefined {
  const text = [
    request.message,
    ...(Array.isArray(request.messages) ? request.messages.map(message => message.content) : [])
  ].join('\n');
  const match = /\[sendblue-showcase:[^\]:]+:([a-z0-9-]+)\]/i.exec(text);
  return match?.[1];
}

export function stripShowcaseTokens(text: string): string {
  return text.replaceAll(/\[sendblue-showcase:[^\]]+\]/gi, '').replaceAll(/\s+/g, ' ').trim();
}

export function isSkipContent(content: string | undefined): boolean {
  return /^\s*(skip|skip this|skip step|next)\s*$/i.test(content ?? '');
}

export function createShowcaseCaptureSink(outputDir: string): ShowcaseCaptureSink {
  const resolvedOutputDir = resolve(outputDir);
  const envelopes: ShowcaseCaptureEnvelope[] = [];
  let sequence = 0;

  return {
    outputDir: resolvedOutputDir,
    envelopes,
    async record(envelope, metadata) {
      await mkdir(resolvedOutputDir, { recursive: true });
      sequence += 1;
      const captured: ShowcaseCaptureEnvelope = {
        ...envelope,
        sequence,
        ...(metadata ? { capture: metadata } : {})
      };
      envelopes.push(captured);
      await writeShowcaseCapture(resolvedOutputDir, captured);
    }
  };
}

export class InstrumentedSendblueClient implements SendblueClient {
  readonly calls: ShowcaseSendblueCall[] = [];

  constructor(private readonly inner: SendblueClient) {}

  async sendMessage(message: SendblueOutboundMessage): Promise<SendblueSendResult> {
    this.record('message', message);
    return this.inner.sendMessage(message);
  }

  async sendGroupMessage(message: SendblueOutboundGroupMessage): Promise<SendblueSendResult> {
    this.record('group-message', message);
    return this.inner.sendGroupMessage(message);
  }

  async sendReaction(reaction: SendblueReactionRequest): Promise<SendblueActionResult> {
    this.record('reaction', reaction);
    return this.inner.sendReaction(reaction);
  }

  async markRead(receipt: SendblueMarkReadRequest): Promise<SendblueActionResult> {
    const call = this.record('read-receipt', receipt);
    try {
      const result = await this.inner.markRead(receipt);
      call.ok = true;
      call.result = result;
      return result;
    } catch (error) {
      call.ok = false;
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async sendTypingIndicator(indicator: SendblueTypingIndicator): Promise<SendblueTypingIndicatorResult> {
    const call = this.record('typing-indicator', indicator);
    try {
      const result = await this.inner.sendTypingIndicator(indicator);
      call.ok = true;
      call.result = result;
      return result;
    } catch (error) {
      call.ok = false;
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async createContact(contact: SendblueContactRequest): Promise<SendblueContactResult> {
    const call = this.record('create-contact', contact);
    try {
      const result = await this.inner.createContact(contact);
      call.ok = true;
      call.result = result;
      return result;
    } catch (error) {
      call.ok = false;
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private record(kind: ShowcaseSendblueCall['kind'], payload: unknown): ShowcaseSendblueCall {
    const call = { kind, at: new Date().toISOString(), payload };
    this.calls.push(call);
    return call;
  }
}

export function summarizeShowcaseStep(options: {
  scenario: ShowcaseScenario;
  skipped: boolean;
  matched: boolean;
  envelopes: ShowcaseCaptureEnvelope[];
  calls: ShowcaseSendblueCall[];
  exchanges?: ShowcaseChatExchange[];
}): ShowcaseStepSummary {
  const receiveEnvelopes = options.envelopes.filter(envelope => envelope.path === '/webhook/receive');
  const firstReceive = receiveEnvelopes[0];
  const exchanges = options.exchanges ?? [];
  const maxBufferedMessageCount = exchanges.reduce((max, exchange) => Math.max(max, exchange.messageCount), 0);

  return {
    scenarioId: options.scenario.id,
    title: options.scenario.title,
    skipped: options.skipped,
    matched: options.matched,
    receiveCount: receiveEnvelopes.length,
    statusCount: options.envelopes.filter(envelope => envelope.path === '/webhook/status').length,
    typingCount: options.calls.filter(call => call.kind === 'typing-indicator').length,
    typingSucceededCount: options.calls.filter(call => call.kind === 'typing-indicator' && call.ok === true).length,
    typingFailedCount: options.calls.filter(call => call.kind === 'typing-indicator' && call.ok === false).length,
    readReceiptCount: options.calls.filter(call => call.kind === 'read-receipt').length,
    readReceiptSucceededCount: options.calls.filter(call => call.kind === 'read-receipt' && call.ok === true).length,
    readReceiptFailedCount: options.calls.filter(call => call.kind === 'read-receipt' && call.ok === false).length,
    reactionCount: options.calls.filter(call => call.kind === 'reaction').length,
    messageCount: options.calls.filter(call => call.kind === 'message').length,
    groupMessageCount: options.calls.filter(call => call.kind === 'group-message').length,
    inboundTypingWebhookCount: options.envelopes.filter(envelope => envelope.path === '/webhook/typing-indicator')
      .length,
    chatRequestCount: exchanges.length,
    maxBufferedMessageCount,
    understood: exchanges.at(-1)?.understood ?? (firstReceive ? summarizeEnvelopeContent(firstReceive) : undefined)
  };
}

function joinedContents(request: ChatEndpointRequest): string {
  const messages = Array.isArray(request.messages) && request.messages.length > 0 ? request.messages : undefined;
  return (messages ? messages.map(message => message.content) : [request.message]).filter(Boolean).join(' | ');
}

function latestTarget(request: ChatEndpointRequest) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const handle = messages.at(-1)?.messageHandle || request.messageHandle;
  return handle ? { messageHandle: handle } : { alias: 'latest' as const };
}

function targetDescription(target: ReturnType<typeof latestTarget>): string {
  if ('messageHandle' in target) return `messageHandle ${target.messageHandle}`;
  return `alias:${target.alias}`;
}

function isSmsLike(request: ChatEndpointRequest): boolean {
  return Boolean(
    request.channel === 'sms' ||
      request.conversation?.channel === 'sms' ||
      request.conversation?.smsDowngraded ||
      request.sendblue.wasDowngraded ||
      request.sendblue.service === 'SMS'
  );
}

function summarizeEnvelopeContent(envelope: ShowcaseCaptureEnvelope): string | undefined {
  const body = envelope.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const content = (body as Record<string, unknown>).content;
  const mediaUrl = (body as Record<string, unknown>).media_url;
  const parts = [typeof content === 'string' ? stripShowcaseTokens(content) : undefined];
  if (typeof mediaUrl === 'string' && mediaUrl) parts.push(`media=${mediaUrl}`);
  return parts.filter(Boolean).join(' ');
}

async function writeShowcaseCapture(outputDir: string, envelope: ShowcaseCaptureEnvelope): Promise<void> {
  const safePath = envelope.path.replace(/^\/+/, '').replaceAll('/', '-') || 'root';
  const scenario = typeof envelope.capture?.scenarioId === 'string' ? `${safeSegment(envelope.capture.scenarioId)}-` : '';
  const sequence = String(envelope.sequence).padStart(4, '0');
  const filename = `${envelope.receivedAt.replaceAll(/[:.]/g, '-')}-${sequence}-${scenario}${safePath}.json`;
  await writeFile(resolve(outputDir, filename), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, '-').replaceAll(/-+/g, '-');
}

function readArg(args: string[], name: string): string | undefined {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolveListen, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolveListen(server));
    server.on('error', reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}
