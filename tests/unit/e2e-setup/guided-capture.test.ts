import { describe, expect, it, vi } from 'vitest';
import { readSetupEnv } from '../../../scripts/e2e/lib/env.js';
import {
  formatCapturePrompt,
  guidedCaptureScenarios,
  scenarioToken,
  sendCapturePrompt
} from '../../../scripts/e2e/lib/guided-capture.js';

describe('guided Sendblue capture helpers', () => {
  it('covers the rich payload scenarios that need real capture', () => {
    expect(guidedCaptureScenarios.map(scenario => scenario.id)).toEqual(
      expect.arrayContaining([
        'basic-text',
        'image-media',
        'video-media',
        'audio-or-file-media',
        'tapback-heart',
        'tapback-thumbs-up',
        'tapback-thumbs-down',
        'tapback-haha',
        'tapback-emphasis',
        'tapback-question',
        'tapback-custom-emoji',
        'effect-balloons',
        'effect-celebration',
        'group-message',
        'sms-fallback'
      ])
    );
  });

  it('formats operator prompts with a stable scenario token', () => {
    const scenario = guidedCaptureScenarios.find(item => item.id === 'tapback-heart')!;
    const prompt = formatCapturePrompt({
      scenario,
      sessionId: 'session-1',
      index: 5,
      total: 14
    });

    expect(prompt).toContain('Capture 5/14: Tapback heart.');
    expect(prompt).toContain(scenarioToken('session-1', 'tapback-heart'));
    expect(prompt).toContain('React to this instruction bubble with a heart tapback');
    expect(prompt).toContain('To skip this step, reply: skip');
  });

  it('includes a custom emoji Tapback investigation scenario', () => {
    const scenario = guidedCaptureScenarios.find(item => item.id === 'tapback-custom-emoji');

    expect(scenario).toMatchObject({
      optional: true,
      expectedWebhook: 'receive'
    });
    expect(scenario?.instruction).toContain('non-standard emoji Tapback');
  });

  it('sends capture prompts through Sendblue with a status callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message_handle: 'prompt-001' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    const env = readSetupEnv(
      {
        SENDBLUE_API_BASE_URL: 'https://api.sendblue.example.test',
        SENDBLUE_API_KEY_ID: 'key',
        SENDBLUE_API_SECRET_KEY: 'secret',
        SENDBLUE_FROM_NUMBER: '+15552220000'
      },
      { includeFiles: false }
    );

    await expect(
      sendCapturePrompt(
        env,
        {
          toNumber: '+15551110000',
          content: 'capture prompt',
          statusCallback: 'https://agent.example.test/webhook/status'
        },
        fetchMock as never
      )
    ).resolves.toEqual({ message_handle: 'prompt-001' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendblue.example.test/api/send-message',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          number: '+15551110000',
          from_number: '+15552220000',
          content: 'capture prompt',
          status_callback: 'https://agent.example.test/webhook/status'
        })
      })
    );
  });
});
