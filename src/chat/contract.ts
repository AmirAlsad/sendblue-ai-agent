import { normalizeResponseActions, parseTaggedActions } from './actions.js';
import { ChatEndpointError } from './errors.js';
import type {
  ChatEndpointResponse,
  ChatResponseTagNames,
  NormalizedChatEndpointResponse
} from './types.js';

export type NormalizeChatResponseOptions = {
  tags?: Partial<ChatResponseTagNames>;
  chatResponseTags?: Partial<ChatResponseTagNames>;
  parseTags?: boolean;
  chatResponseParseTags?: boolean;
};

export function normalizeChatResponse(
  payload: unknown,
  options: NormalizeChatResponseOptions = {}
): NormalizedChatEndpointResponse {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ChatEndpointError('Chat endpoint response must be an object');
  }

  const response = payload as ChatEndpointResponse;
  if (topLevelSilenceMixedWithActions(response)) {
    return {
      actions: [],
      warnings: [
        {
          code: 'mixed-silence-actions',
          message: 'Chat response mixed silence with outbound actions; dropping response'
        }
      ]
    };
  }

  const normalized = normalizeResponseActions(response, {
    parseTags: options.parseTags ?? options.chatResponseParseTags ?? true,
    tags: normalizeTags(options)
  });

  const onlySilence = normalized.actions.length === 1 && normalized.actions[0].type === 'silence';
  if (onlySilence) {
    return normalized.warnings.length > 0
      ? { actions: [], silence: true, warnings: normalized.warnings }
      : { actions: [], silence: true };
  }

  if (normalized.actions.length > 0) {
    return normalized.warnings.length > 0
      ? { actions: normalized.actions, warnings: normalized.warnings }
      : { actions: normalized.actions };
  }

  if ('silence' in response && response.silence === true) {
    return normalized.warnings.length > 0
      ? { actions: [], silence: true, warnings: normalized.warnings }
      : { actions: [], silence: true };
  }

  if (recognizedResponse(response)) {
    return normalized.warnings.length > 0 ? { actions: [], warnings: normalized.warnings } : { actions: [] };
  }

  throw new ChatEndpointError('Chat endpoint response did not include message, messages, actions, or silence');
}

function topLevelSilenceMixedWithActions(response: ChatEndpointResponse): boolean {
  if (!('silence' in response) || response.silence !== true) return false;
  if ('message' in response && typeof response.message === 'string' && response.message.trim() !== '') return true;
  if ('messages' in response && Array.isArray(response.messages) && response.messages.some(item => typeof item === 'string' && item.trim() !== '')) {
    return true;
  }
  return 'actions' in response && Array.isArray(response.actions) && response.actions.length > 0;
}

export function outboundMessagesFromResponse(
  response: ChatEndpointResponse,
  options: NormalizeChatResponseOptions = {}
): string[] {
  return normalizeChatResponse(response, options)
    .actions.filter(action => action.type === 'message' || action.type === 'reply' || action.type === 'media')
    .map(action => ('content' in action ? action.content ?? '' : ''))
    .filter(content => content.trim() !== '');
}

export function parseTaggedText(
  text: string,
  tags?: ChatResponseTagNames
): { actions: NormalizedChatEndpointResponse['actions']; warnings: [] } {
  return { actions: parseTaggedActions(text, { tags }) ?? [{ type: 'message', content: text }], warnings: [] };
}

function recognizedResponse(response: ChatEndpointResponse): boolean {
  return (
    ('message' in response && typeof response.message === 'string') ||
    ('messages' in response && Array.isArray(response.messages)) ||
    ('actions' in response && Array.isArray(response.actions))
  );
}

function normalizeTags(options: NormalizeChatResponseOptions): ChatResponseTagNames {
  const raw = options.tags ?? options.chatResponseTags ?? {};
  return {
    message: raw.message ?? 'message',
    noResponse: raw.noResponse ?? 'no_response',
    reaction: raw.reaction ?? 'reaction',
    reply: raw.reply ?? 'reply'
  };
}
