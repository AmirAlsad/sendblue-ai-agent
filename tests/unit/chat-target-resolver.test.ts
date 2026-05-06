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
});
