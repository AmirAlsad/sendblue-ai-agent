import { tool } from 'ai';
import { z } from 'zod';

// Mirrors src/sendblue/types.ts in the parent transport package. Kept in
// sync by hand because this example deliberately doesn't depend on the
// parent package — it's meant to be portable.
const REACTIONS = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'] as const;
const SEND_STYLES = [
  'celebration',
  'shooting_star',
  'fireworks',
  'lasers',
  'love',
  'confetti',
  'balloons',
  'spotlight',
  'echo',
  'invisible',
  'gentle',
  'loud',
  'slam'
] as const;

export type ChatAction =
  | { type: 'message'; content: string; mediaUrl?: string; sendStyle?: (typeof SEND_STYLES)[number] }
  | { type: 'media'; mediaUrl: string; content?: string; sendStyle?: (typeof SEND_STYLES)[number] }
  | { type: 'reply'; target: { messageHandle: string }; content: string }
  | { type: 'reaction'; reaction: (typeof REACTIONS)[number]; target: { messageHandle: string } }
  | { type: 'silence' };

export interface ActionCollector {
  actions: ChatAction[];
  silent: boolean;
}

export function createCollector(): ActionCollector {
  return { actions: [], silent: false };
}

/**
 * Models sometimes pass back the entire `handle:<id>` token they saw in
 * the per-turn context block. Strip the prefix defensively so the resulting
 * `messageHandle` matches the inbound id Sendblue gave us.
 */
function stripHandlePrefix(value: string): string {
  return value.replace(/^handle:/, '').trim();
}

export function createActionTools(collector: ActionCollector) {
  return {
    send_message: tool({
      description:
        'Send a normal text reply to the user. Use this for almost everything. ' +
        'Optional sendStyle adds an iMessage send effect — use sparingly for celebratory moments. ' +
        'You can call this multiple times in a turn to send a short series of messages.',
      inputSchema: z.object({
        text: z.string().min(1).describe('The message body. Keep it conversational, like a text message.'),
        sendStyle: z.enum(SEND_STYLES).optional().describe('iMessage send effect; dropped on SMS/RCS.')
      }),
      execute: async ({ text, sendStyle }) => {
        collector.actions.push({
          type: 'message',
          content: text,
          ...(sendStyle ? { sendStyle } : {})
        });
        return { ok: true };
      }
    }),

    send_media: tool({
      description:
        'Send an image or document to the user via a publicly hosted HTTPS URL. ' +
        'Sendblue fetches the URL at send time. Optionally include a caption.',
      inputSchema: z.object({
        url: z.string().url().describe('Publicly fetchable HTTPS URL of the media file.'),
        caption: z.string().optional().describe('Optional text caption shown alongside the media.')
      }),
      execute: async ({ url, caption }) => {
        collector.actions.push({
          type: 'media',
          mediaUrl: url,
          ...(caption ? { content: caption } : {})
        });
        return { ok: true };
      }
    }),

    react: tool({
      description:
        'Drop a Tapback reaction on a specific inbound message. Use it when a single ' +
        'reaction is the right answer (e.g. user says "thanks" — react with `love` and ' +
        'send no message). iMessage only — the transport drops this automatically on SMS/RCS.',
      inputSchema: z.object({
        emoji: z.enum(REACTIONS).describe('Reaction type.'),
        targetMessageHandle: z
          .string()
          .min(1)
          .describe('The id of the inbound message to react to — the value after `handle:` in `[handle:<id>]`.')
      }),
      execute: async ({ emoji, targetMessageHandle }) => {
        collector.actions.push({
          type: 'reaction',
          reaction: emoji,
          target: { messageHandle: stripHandlePrefix(targetMessageHandle) }
        });
        return { ok: true };
      }
    }),

    reply_to: tool({
      description:
        'Send a contextual reply to a specific inbound message. Useful when the user ' +
        'sent multiple messages and an unanchored reply would be ambiguous.',
      inputSchema: z.object({
        targetMessageHandle: z
          .string()
          .min(1)
          .describe('The id of the inbound message to reply to — the value after `handle:` in `[handle:<id>]`.'),
        text: z.string().min(1).describe('Reply body.')
      }),
      execute: async ({ targetMessageHandle, text }) => {
        collector.actions.push({
          type: 'reply',
          target: { messageHandle: stripHandlePrefix(targetMessageHandle) },
          content: text
        });
        return { ok: true };
      }
    }),

    stay_silent: tool({
      description:
        'Send absolutely nothing — no text, no reaction, no media. Use only when the ' +
        "inbound clearly does not need a response (e.g. an automated 'thanks' that you " +
        'already reacted to in a previous turn). Do NOT call this if you have called ' +
        '`react` in the same turn — a reaction alone IS the response. Calling stay_silent ' +
        'cancels every other queued action.',
      inputSchema: z.object({
        reason: z.string().optional().describe('Optional internal note for logs; not sent to the user.')
      }),
      execute: async ({ reason }) => {
        collector.silent = true;
        collector.actions = [];
        return { ok: true, reason: reason ?? null };
      }
    })
  };
}
