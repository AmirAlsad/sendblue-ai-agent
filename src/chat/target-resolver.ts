import type { ChatEndpointMessage, TargetRef } from './types.js';

export type TargetResolverMessage = Pick<ChatEndpointMessage, 'content' | 'messageHandle'> & {
  partIndex?: number;
  aliases?: string[];
};

export type TargetResolution =
  | {
      ok: true;
      target: TargetResolverMessage;
      index: number;
    }
  | {
      ok: false;
      reason: 'missing_history' | 'missing_target' | 'not_found' | 'ambiguous' | 'invalid_part_index';
      matches?: TargetResolverMessage[];
    };

export function resolveTargetRef(history: TargetResolverMessage[], target?: TargetRef): TargetResolution {
  if (history.length === 0) return { ok: false, reason: 'missing_history' };

  if (!target) {
    return resolved(history, history.length - 1);
  }

  if ('messageHandle' in target) {
    const index = history.findIndex(message => message.messageHandle === target.messageHandle);
    return index === -1 ? { ok: false, reason: 'not_found' } : resolved(history, index);
  }

  if ('alias' in target) {
    const aliasResult = resolveAlias(history, target.alias);
    if (aliasResult.ok || aliasResult.reason !== 'not_found') return aliasResult;
    if (!targetContent(target) && target.partIndex === undefined) return aliasResult;
  }

  let candidates = history.map((message, index) => ({ message, index }));
  const content = targetContent(target);

  if (content) {
    const exact = candidates.filter(candidate => normalized(candidate.message.content) === normalized(content));
    candidates =
      exact.length > 0
        ? exact
        : candidates.filter(candidate => normalized(candidate.message.content).includes(normalized(content)));
    if ('contentIncludes' in target && target.occurrence === 'first' && candidates[0]) {
      return resolved(history, candidates[0].index);
    }
    if ('contentIncludes' in target && target.occurrence === 'last' && candidates[0]) {
      return resolved(history, candidates[candidates.length - 1].index);
    }
  }

  if (target.partIndex !== undefined) {
    if (!Number.isInteger(target.partIndex) || target.partIndex < 0) {
      return { ok: false, reason: 'invalid_part_index' };
    }

    const withPartIndex = candidates.filter(candidate => candidate.message.partIndex === target.partIndex);
    if (withPartIndex.length > 0) candidates = withPartIndex;
    else if (!content && target.partIndex < history.length) return resolved(history, target.partIndex);
    else if (content && target.partIndex < candidates.length) return resolved(history, candidates[target.partIndex].index);
    else return { ok: false, reason: 'invalid_part_index', matches: candidates.map(candidate => candidate.message) };
  }

  if (candidates.length === 0) return { ok: false, reason: 'not_found' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', matches: candidates.map(candidate => candidate.message) };
  return resolved(history, candidates[0].index);
}

function resolveAlias(history: TargetResolverMessage[], alias: string): TargetResolution {
  const normalizedAlias = normalized(alias);
  if (['last', 'latest', 'current'].includes(normalizedAlias)) return resolved(history, history.length - 1);
  if (['first', 'oldest'].includes(normalizedAlias)) return resolved(history, 0);
  if (['previous', 'prior'].includes(normalizedAlias)) {
    return history.length < 2 ? { ok: false, reason: 'not_found' } : resolved(history, history.length - 2);
  }

  const matches = history
    .map((message, index) => ({ message, index }))
    .filter(candidate => (candidate.message.aliases ?? []).some(item => normalized(item) === normalizedAlias));

  if (matches.length === 0) return { ok: false, reason: 'not_found' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches: matches.map(match => match.message) };
  return resolved(history, matches[0].index);
}

function resolved(history: TargetResolverMessage[], index: number): TargetResolution {
  return {
    ok: true,
    target: history[index],
    index
  };
}

function targetContent(target: TargetRef): string | undefined {
  if ('content' in target) return target.content;
  if ('contentIncludes' in target) return target.contentIncludes;
  return undefined;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}
