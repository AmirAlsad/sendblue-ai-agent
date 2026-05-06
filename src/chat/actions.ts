import {
  SENDBLUE_REACTIONS,
  SENDBLUE_SEND_STYLES,
  type SendblueReaction,
  type SendblueSendStyle
} from '../sendblue/types.js';
import type {
  ChatAction,
  ChatContractWarning,
  ChatEndpointMessage,
  ChatEndpointResponse,
  ChatResponseTagNames,
  TargetRef
} from './types.js';

export type NormalizedActionResult = {
  actions: ChatAction[];
  warnings: ChatContractWarning[];
};

export type ResolvedTarget = {
  messageHandle: string;
  partIndex?: number;
  message: ChatEndpointMessage;
};

export type TargetResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: 'missing-target' | 'not-found' | 'ambiguous' | 'invalid-alias' };

const DEFAULT_TAGS: ChatResponseTagNames = {
  message: 'message',
  noResponse: 'no_response',
  reaction: 'reaction',
  reply: 'reply'
};

export function normalizeResponseActions(
  response: ChatEndpointResponse,
  options: {
    parseTags?: boolean;
    tags?: ChatResponseTagNames;
  } = {}
): NormalizedActionResult {
  const warnings: ChatContractWarning[] = [];
  let actions: ChatAction[] = [];

  if ('actions' in response && Array.isArray(response.actions)) {
    actions = response.actions.flatMap((action, index) => normalizeAction(action, `actions.${index}`, warnings));
  } else if ('silence' in response && response.silence === true) {
    actions = [{ type: 'silence' }];
  } else if ('messages' in response && Array.isArray(response.messages)) {
    actions = response.messages.flatMap((message, index) =>
      actionsFromMessageText(message, options, `messages.${index}`, warnings)
    );
  } else if ('message' in response && typeof response.message === 'string') {
    actions = actionsFromMessageText(response.message, options, 'message', warnings);
  }

  const includesSilence = actions.some(action => action.type === 'silence');
  if (includesSilence && actions.length > 1) {
    warnings.push({
      code: 'mixed-silence-actions',
      message: 'Chat response mixed silence with outbound actions; dropping response'
    });
    return { actions: [], warnings };
  }

  return {
    actions,
    warnings
  };
}

export function normalizeAction(
  value: unknown,
  path = 'action',
  warnings: ChatContractWarning[] = []
): ChatAction[] {
  if (!isRecord(value) || typeof value.type !== 'string') {
    warnings.push({ code: 'invalid-action', message: 'Chat action must be an object with type', path });
    return [];
  }

  switch (value.type) {
    case 'message': {
      const content = readString(value, 'content') ?? readString(value, 'message');
      const mediaUrl = readString(value, 'mediaUrl') ?? readString(value, 'media_url');
      if (!content && !mediaUrl) {
        warnings.push({ code: 'invalid-message-action', message: 'Message action requires content or mediaUrl', path });
        return [];
      }
      return [
        {
          type: 'message',
          content: content ?? '',
          mediaUrl,
          sendStyle: normalizeSendStyle(readString(value, 'sendStyle') ?? readString(value, 'send_style'))
        }
      ];
    }
    case 'media': {
      const mediaUrl = readString(value, 'mediaUrl') ?? readString(value, 'media_url') ?? readString(value, 'url');
      if (!mediaUrl) {
        warnings.push({ code: 'invalid-media-action', message: 'Media action requires mediaUrl', path });
        return [];
      }
      return [
        {
          type: 'media',
          mediaUrl,
          content: readString(value, 'content') ?? readString(value, 'message'),
          sendStyle: normalizeSendStyle(readString(value, 'sendStyle') ?? readString(value, 'send_style'))
        }
      ];
    }
    case 'reaction': {
      const reaction = normalizeReaction(readString(value, 'reaction') ?? readString(value, 'type'));
      const target = normalizeTargetRef(value.target) ?? { alias: 'last' };
      if (!reaction || !target) {
        warnings.push({ code: 'invalid-reaction-action', message: 'Reaction action requires reaction and target', path });
        return [];
      }
      return [{ type: 'reaction', reaction, target }];
    }
    case 'reply': {
      const target = normalizeTargetRef(value.target) ?? { alias: 'last' };
      const content = readString(value, 'content') ?? readString(value, 'message');
      const mediaUrl = readString(value, 'mediaUrl') ?? readString(value, 'media_url');
      if (!target || (!content && !mediaUrl)) {
        warnings.push({ code: 'invalid-reply-action', message: 'Reply action requires target and content or mediaUrl', path });
        return [];
      }
      return [
        {
          type: 'reply',
          target,
          content: content ?? '',
          mediaUrl,
          sendStyle: normalizeSendStyle(readString(value, 'sendStyle') ?? readString(value, 'send_style'))
        }
      ];
    }
    case 'silence':
      return [{ type: 'silence' }];
    default:
      warnings.push({ code: 'unknown-action-type', message: `Unsupported chat action type: ${value.type}`, path });
      return [];
  }
}

export function parseTaggedActions(
  text: string,
  options: {
    tags?: ChatResponseTagNames;
  } = {}
): ChatAction[] | null {
  const tags = options.tags ?? DEFAULT_TAGS;
  const names = [tags.message, tags.noResponse, tags.reaction, tags.reply].map(escapeRegExp).join('|');
  const tagPattern = new RegExp(
    `<(${names})(\\s[^>]*)?\\s*/>|<(${names})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\3>`,
    'gi'
  );

  const actions: ChatAction[] = [];
  let matched = false;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(text)) !== null) {
    matched = true;
    appendPlainTextAction(text.slice(cursor, match.index), actions);
    const tagName = match[1] ?? match[3];
    const attrs = parseAttributes(match[2] ?? match[4] ?? '');
    const body = decodeEntities(match[5] ?? '').trim();

    if (tagName === tags.noResponse) {
      actions.push({ type: 'silence' });
    } else if (tagName === tags.message) {
      const content = body;
      const mediaUrl = attrs.media_url ?? attrs.mediaUrl;
      if (content || mediaUrl) {
        actions.push({
          type: 'message',
          content,
          mediaUrl,
          sendStyle: normalizeSendStyle(attrs.send_style ?? attrs.sendStyle)
        });
      }
    } else if (tagName === tags.reaction) {
      const reaction = normalizeReaction(attrs.type ?? attrs.reaction ?? body);
      const target = targetFromAttributes(attrs) ?? { alias: 'last' };
      if (reaction && target) {
        actions.push({ type: 'reaction', reaction, target });
      }
    } else if (tagName === tags.reply) {
      const target = targetFromAttributes(attrs) ?? { alias: 'last' };
      const nested = parseFirstMessageTag(body, tags);
      const content = nested?.content ?? stripTags(body).trim();
      if (target && (content || nested?.mediaUrl)) {
        actions.push({
          type: 'reply',
          target,
          content,
          mediaUrl: nested?.mediaUrl,
          sendStyle: nested?.sendStyle ?? normalizeSendStyle(attrs.send_style ?? attrs.sendStyle)
        });
      }
    }

    cursor = match.index + match[0].length;
  }

  if (matched) appendPlainTextAction(text.slice(cursor), actions);
  return matched ? actions : null;
}

export function resolveTargetRef(
  target: TargetRef,
  messages: ChatEndpointMessage[]
): TargetResolution {
  if ('messageHandle' in target) {
    const message = messages.find(item => item.messageHandle === target.messageHandle);
    return message
      ? { ok: true, target: { messageHandle: target.messageHandle, partIndex: target.partIndex, message } }
      : { ok: false, reason: 'not-found' };
  }

  if ('alias' in target) {
    const index =
      target.alias === 'first'
        ? 0
        : target.alias === 'previous'
          ? messages.length - 2
          : target.alias === 'latest' || target.alias === 'last'
            ? messages.length - 1
            : -1;
    const message = messages[index];
    return message
      ? { ok: true, target: { messageHandle: message.messageHandle, partIndex: target.partIndex, message } }
      : { ok: false, reason: target.alias === 'previous' ? 'not-found' : 'invalid-alias' };
  }

  let contentIncludes: string | undefined;
  if ('contentIncludes' in target) contentIncludes = target.contentIncludes;
  else if ('content' in target) contentIncludes = target.content;
  if (!contentIncludes) return { ok: false, reason: 'missing-target' };
  const matches = messages.filter(message => message.content.includes(contentIncludes));
  if (matches.length === 0) return { ok: false, reason: 'not-found' };
  const occurrence = 'occurrence' in target ? target.occurrence : undefined;
  if (matches.length > 1 && !occurrence) return { ok: false, reason: 'ambiguous' };
  const message = occurrence === 'first' ? matches[0] : matches[matches.length - 1];
  return { ok: true, target: { messageHandle: message.messageHandle, partIndex: target.partIndex, message } };
}

function actionsFromMessageText(
  text: string,
  options: { parseTags?: boolean; tags?: ChatResponseTagNames },
  path: string,
  warnings: ChatContractWarning[]
): ChatAction[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  if (options.parseTags) {
    const parsed = parseTaggedActions(text, { tags: options.tags });
    if (parsed) return parsed;
  }
  return [{ type: 'message', content: text }];
}

function normalizeTargetRef(value: unknown): TargetRef | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.messageHandle === 'string' && value.messageHandle.trim() !== '') {
    return {
      messageHandle: value.messageHandle,
      partIndex: normalizePartIndex(value.partIndex)
    };
  }
  if (typeof value.alias === 'string' && value.alias.trim() !== '') {
    return {
      alias: value.alias,
      partIndex: normalizePartIndex(value.partIndex)
    };
  }
  if (typeof value.content === 'string' && value.content.trim() !== '') {
    return {
      content: value.content,
      partIndex: normalizePartIndex(value.partIndex)
    };
  }
  if (typeof value.contentIncludes === 'string' && value.contentIncludes.trim() !== '') {
    const occurrence = value.occurrence === 'first' || value.occurrence === 'last' ? value.occurrence : undefined;
    return {
      contentIncludes: value.contentIncludes,
      occurrence,
      partIndex: normalizePartIndex(value.partIndex)
    };
  }
  return undefined;
}

function targetFromAttributes(attrs: Record<string, string>): TargetRef | undefined {
  const partIndex = normalizePartIndex(attrs.part_index ?? attrs.partIndex);
  const handle = attrs.target_message_handle ?? attrs.message_handle ?? attrs.messageHandle;
  if (handle) return { messageHandle: handle, partIndex };
  const alias = attrs.target ?? attrs.alias;
  if (alias) return { alias, partIndex };
  const content = attrs.content ?? attrs.target_content ?? attrs.targetContent;
  if (content) return { contentIncludes: content, partIndex };
  const contentIncludes = attrs.content_includes ?? attrs.contentIncludes;
  if (contentIncludes) {
    const occurrence = attrs.occurrence === 'first' || attrs.occurrence === 'last' ? attrs.occurrence : undefined;
    return { contentIncludes, occurrence, partIndex };
  }
  return undefined;
}

function appendPlainTextAction(text: string, actions: ChatAction[]): void {
  const content = decodeEntities(text).trim();
  if (content) actions.push({ type: 'message', content });
}

function parseFirstMessageTag(
  text: string,
  tags: ChatResponseTagNames
): { content: string; mediaUrl?: string; sendStyle?: SendblueSendStyle } | undefined {
  const pattern = new RegExp(`<${escapeRegExp(tags.message)}(\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tags.message)}>`, 'i');
  const match = pattern.exec(text);
  if (!match) return undefined;
  const attrs = parseAttributes(match[1] ?? '');
  return {
    content: decodeEntities(match[2] ?? '').trim(),
    mediaUrl: attrs.media_url ?? attrs.mediaUrl,
    sendStyle: normalizeSendStyle(attrs.send_style ?? attrs.sendStyle)
  };
}

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizeSendStyle(value: unknown): SendblueSendStyle | undefined {
  return typeof value === 'string' && SENDBLUE_SEND_STYLES.includes(value as SendblueSendStyle)
    ? (value as SendblueSendStyle)
    : undefined;
}

function normalizeReaction(value: unknown): SendblueReaction | undefined {
  if (value === 'heart') return 'love';
  if (value === 'haha') return 'laugh';
  return typeof value === 'string' && SENDBLUE_REACTIONS.includes(value as SendblueReaction)
    ? (value as SendblueReaction)
    : undefined;
}

function normalizePartIndex(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
