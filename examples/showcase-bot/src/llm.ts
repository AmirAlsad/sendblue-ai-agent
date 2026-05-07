import {
  createProviderRegistry,
  generateText,
  stepCountIs,
  type ModelMessage,
  type TextPart,
  type ImagePart
} from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { BotConfig } from './config.js';
import { log } from './logger.js';
import { buildMediaContent } from './media-processor.js';
import { createActionTools, createCollector, type ChatAction } from './tools.js';

const registry = createProviderRegistry({ anthropic, openai });

// Per-conversation message history. Keyed by conversation.key (one record
// per conversation pair, matching the transport's keying — survives
// channel switches).
const history = new Map<string, ModelMessage[]>();

export interface InboundMessage {
  handle: string;
  text: string;
  channel: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
}

export interface ChatTurn {
  conversationKey: string;
  channel: string;
  wasDowngraded: boolean;
  identityLabel?: string;
  inboundMessages: InboundMessage[];
}

export interface ChatTurnResult {
  actions: ChatAction[];
  silent: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
  latencyMs: number;
}

export async function runTurn(config: BotConfig, turn: ChatTurn): Promise<ChatTurnResult> {
  const channelHistory = history.get(turn.conversationKey) ?? [];
  const collector = createCollector();
  const tools = createActionTools(collector);

  const userContent = await buildUserContent(turn);
  channelHistory.push({ role: 'user', content: userContent });

  const isAnthropic = config.model.startsWith('anthropic:');
  const system = isAnthropic
    ? {
        role: 'system' as const,
        content: config.systemPrompt,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }
      }
    : config.systemPrompt;

  const startTime = performance.now();
  const result = await generateText({
    model: registry.languageModel(config.model as Parameters<typeof registry.languageModel>[0]),
    maxOutputTokens: config.maxTokens,
    system,
    messages: channelHistory,
    tools,
    stopWhen: stepCountIs(config.maxSteps),
    onStepFinish({ toolCalls }) {
      for (const tc of toolCalls) {
        log('debug', `tool call: ${tc.toolName}`, {
          conversationKey: turn.conversationKey,
          input: tc.input as Record<string, unknown>
        });
      }
    }
  });
  const latencyMs = Math.round(performance.now() - startTime);

  channelHistory.push(...result.response.messages);
  history.set(turn.conversationKey, channelHistory);

  // If the model also produced a final text message after its tool calls,
  // include it as a `message` action — but only when it wouldn't double-up
  // with a send_message tool call (skip if any message/reply/media action
  // already exists).
  const finalText = result.text?.trim();
  const alreadyHasOutbound = collector.actions.some(
    a => a.type === 'message' || a.type === 'reply' || a.type === 'media'
  );
  if (finalText && !collector.silent && !alreadyHasOutbound) {
    collector.actions.push({ type: 'message', content: finalText });
  }

  return {
    actions: collector.actions,
    silent: collector.silent,
    usage: {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
      ...(result.usage.inputTokenDetails?.cacheReadTokens != null
        ? { cachedTokens: result.usage.inputTokenDetails.cacheReadTokens }
        : {})
    },
    latencyMs
  };
}

async function buildUserContent(turn: ChatTurn): Promise<string | Array<TextPart | ImagePart>> {
  const contextHeader = formatContextHeader(turn);

  // Plain text turn (no media on any message).
  const hasMedia = turn.inboundMessages.some(m => m.mediaUrl && m.mediaType);
  if (!hasMedia) {
    const lines = turn.inboundMessages.map(m => `[handle:${m.handle}] ${m.text || ''}`.trim());
    return `${contextHeader}\n\n${lines.join('\n')}`.trim();
  }

  // Mixed media turn — process each message into AI SDK parts.
  const parts: Array<TextPart | ImagePart> = [];
  parts.push({ type: 'text', text: contextHeader });
  for (const m of turn.inboundMessages) {
    parts.push({ type: 'text', text: `[handle:${m.handle}]` });
    if (m.mediaUrl && m.mediaType) {
      const processed = await buildMediaContent(m.mediaType, m.mediaUrl, m.text || '');
      parts.push(...processed.content);
    } else {
      parts.push({ type: 'text', text: m.text || '' });
    }
  }
  return parts;
}

function formatContextHeader(turn: ChatTurn): string {
  const lines = [`[conversation channel=${turn.channel} downgraded=${turn.wasDowngraded}]`];
  if (turn.identityLabel) lines.push(`[user: ${turn.identityLabel}]`);
  return lines.join('\n');
}

export function clearHistory(conversationKey?: string): void {
  if (conversationKey) history.delete(conversationKey);
  else history.clear();
}
