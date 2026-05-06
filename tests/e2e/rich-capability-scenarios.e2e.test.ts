import { describe, expect, it } from 'vitest';

type RichScenario = {
  id: string;
  actionTypes: string[];
  requiresLiveSendblue: boolean;
  safetyGate: string;
};

const richScenarios: RichScenario[] = [
  {
    id: 'actions-multi-message',
    actionTypes: ['message', 'message'],
    requiresLiveSendblue: false,
    safetyGate: 'legacy messages normalize to ordered message actions'
  },
  {
    id: 'actions-silence',
    actionTypes: ['silence'],
    requiresLiveSendblue: false,
    safetyGate: 'silence produces no Sendblue call'
  },
  {
    id: 'xml-multi-message-tags',
    actionTypes: ['message', 'message'],
    requiresLiveSendblue: false,
    safetyGate: 'XML tags normalize to the same action model as JSON'
  },
  {
    id: 'hosted-media',
    actionTypes: ['message'],
    requiresLiveSendblue: true,
    safetyGate: 'mediaUrl is HTTPS and fetchable by Sendblue before delivery'
  },
  {
    id: 'send-effect',
    actionTypes: ['message'],
    requiresLiveSendblue: true,
    safetyGate: 'sendStyle is direct iMessage-only and falls back on SMS downgrade'
  },
  {
    id: 'reaction',
    actionTypes: ['reaction'],
    requiresLiveSendblue: true,
    safetyGate: 'reaction has a captured target and never duplicates text fallback sends'
  },
  {
    id: 'reply',
    actionTypes: ['reply'],
    requiresLiveSendblue: true,
    safetyGate: 'reply intent degrades to a normal Sendblue message until native reply API exists'
  },
  {
    id: 'read-receipt',
    actionTypes: ['agent_read_receipt'],
    requiresLiveSendblue: true,
    safetyGate: 'READ_RECEIPTS_ENABLED gates best-effort mark-read calls until on-device display is verified'
  },
  {
    id: 'typing-refresh',
    actionTypes: ['agent_typing_refresh', 'message'],
    requiresLiveSendblue: true,
    safetyGate: 'typing refresh stops on completion, interruption, terminal status, or SMS downgrade'
  },
  {
    id: 'addressed-group-routing',
    actionTypes: ['message'],
    requiresLiveSendblue: true,
    safetyGate: 'AGENT_DISPLAY_NAME mention or known agent outbound reference is required before any group reply'
  }
];

describe('rich Sendblue capability scenario placeholders', () => {
  it('keeps the rich capability matrix behind the E2E command', () => {
    expect(richScenarios.map(scenario => scenario.id)).toEqual([
      'actions-multi-message',
      'actions-silence',
      'xml-multi-message-tags',
      'hosted-media',
      'send-effect',
      'reaction',
      'reply',
      'read-receipt',
      'typing-refresh',
      'addressed-group-routing'
    ]);
  });

  it('marks scenarios that need real Sendblue observation before promotion', () => {
    const liveScenarioIds = richScenarios
      .filter(scenario => scenario.requiresLiveSendblue)
      .map(scenario => scenario.id);

    expect(liveScenarioIds).toEqual([
      'hosted-media',
      'send-effect',
      'reaction',
      'reply',
      'read-receipt',
      'typing-refresh',
      'addressed-group-routing'
    ]);
  });

  it('documents a safety gate for every placeholder', () => {
    expect(richScenarios.every(scenario => scenario.safetyGate.length > 20)).toBe(true);
    expect(richScenarios.find(scenario => scenario.id === 'actions-silence')?.safetyGate).toContain(
      'no Sendblue call'
    );
    expect(richScenarios.find(scenario => scenario.id === 'addressed-group-routing')?.safetyGate).toContain(
      'AGENT_DISPLAY_NAME'
    );
  });
});
