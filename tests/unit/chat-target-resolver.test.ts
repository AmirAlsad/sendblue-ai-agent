import { describe, expect, it } from 'vitest';
import { resolveTargetRef, type TargetResolverMessage } from '../../src/chat/target-resolver.js';

const history: TargetResolverMessage[] = [
  {
    messageHandle: 'recv-1',
    content: 'first question',
    partIndex: 0,
    aliases: ['opening']
  },
  {
    messageHandle: 'recv-2',
    content: 'duplicate text',
    partIndex: 1,
    aliases: ['middle']
  },
  {
    messageHandle: 'recv-3',
    content: 'duplicate text',
    partIndex: 2,
    aliases: ['closing']
  }
];

describe('chat target resolver', () => {
  it('resolves exact message handles first', () => {
    expect(resolveTargetRef(history, { messageHandle: 'recv-2' })).toMatchObject({
      ok: true,
      index: 1,
      target: { messageHandle: 'recv-2' }
    });
  });

  it('resolves built-in and explicit aliases', () => {
    expect(resolveTargetRef(history, { alias: 'last' })).toMatchObject({
      ok: true,
      index: 2
    });
    expect(resolveTargetRef(history, { alias: 'opening' })).toMatchObject({
      ok: true,
      index: 0
    });
    expect(resolveTargetRef(history, { alias: 'missing' })).toEqual({
      ok: false,
      reason: 'not_found'
    });
  });

  it('resolves content matches and reports ambiguity', () => {
    expect(resolveTargetRef(history, { content: 'first question' })).toMatchObject({
      ok: true,
      index: 0
    });

    const ambiguous = resolveTargetRef(history, { content: 'duplicate text' });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous).toMatchObject({
      reason: 'ambiguous',
      matches: [{ messageHandle: 'recv-2' }, { messageHandle: 'recv-3' }]
    });
  });

  it('uses partIndex to disambiguate inbound history', () => {
    expect(resolveTargetRef(history, { content: 'duplicate text', partIndex: 2 })).toMatchObject({
      ok: true,
      index: 2,
      target: { messageHandle: 'recv-3' }
    });

    expect(resolveTargetRef(history, { partIndex: 1 })).toMatchObject({
      ok: true,
      index: 1,
      target: { messageHandle: 'recv-2' }
    });
  });

  it('reports invalid partIndex and missing history distinctly', () => {
    expect(resolveTargetRef(history, { content: 'duplicate text', partIndex: 99 })).toMatchObject({
      ok: false,
      reason: 'invalid_part_index'
    });
    expect(resolveTargetRef([], { alias: 'last' })).toEqual({
      ok: false,
      reason: 'missing_history'
    });
  });

  it('resolves all built-in alias spellings including current/oldest/prior', () => {
    expect(resolveTargetRef(history, { alias: 'current' })).toMatchObject({ ok: true, index: 2 });
    expect(resolveTargetRef(history, { alias: 'latest' })).toMatchObject({ ok: true, index: 2 });
    expect(resolveTargetRef(history, { alias: 'oldest' })).toMatchObject({ ok: true, index: 0 });
    expect(resolveTargetRef(history, { alias: 'first' })).toMatchObject({ ok: true, index: 0 });
    expect(resolveTargetRef(history, { alias: 'prior' })).toMatchObject({ ok: true, index: 1 });
    expect(resolveTargetRef(history, { alias: 'previous' })).toMatchObject({ ok: true, index: 1 });
  });

  it('returns latest when no target is supplied', () => {
    expect(resolveTargetRef(history)).toMatchObject({ ok: true, index: 2 });
  });

  it('reports not_found when previous is requested with single-message history', () => {
    expect(resolveTargetRef([history[0]], { alias: 'previous' })).toEqual({
      ok: false,
      reason: 'not_found'
    });
  });

  it('rejects negative or non-integer partIndex without content', () => {
    expect(resolveTargetRef(history, { partIndex: -1 })).toMatchObject({
      ok: false,
      reason: 'invalid_part_index'
    });
    expect(resolveTargetRef(history, { partIndex: 1.5 })).toMatchObject({
      ok: false,
      reason: 'invalid_part_index'
    });
  });

  it('honors first / last occurrence when content is ambiguous', () => {
    expect(
      resolveTargetRef(history, { contentIncludes: 'duplicate text', occurrence: 'first' })
    ).toMatchObject({ ok: true, index: 1 });
    expect(
      resolveTargetRef(history, { contentIncludes: 'duplicate text', occurrence: 'last' })
    ).toMatchObject({ ok: true, index: 2 });
  });

  it('does case-insensitive content matching', () => {
    expect(resolveTargetRef(history, { content: 'FIRST QUESTION' })).toMatchObject({
      ok: true,
      index: 0
    });
  });
});
