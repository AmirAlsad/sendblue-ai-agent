import type { E2ESetupEnv } from './env.js';

export type GuidedCaptureScenario = {
  id: string;
  title: string;
  instruction: string;
  expectedWebhook: 'receive' | 'status' | 'both';
  optional?: boolean;
  settleMs?: number;
};

export type SendCapturePromptOptions = {
  toNumber: string;
  content: string;
  statusCallback: string;
};

export const guidedCaptureScenarios: GuidedCaptureScenario[] = [
  {
    id: 'basic-text',
    title: 'Basic inbound text',
    expectedWebhook: 'receive',
    instruction: 'Reply with the exact bracketed token and a short text message.'
  },
  {
    id: 'image-media',
    title: 'Inbound image media',
    expectedWebhook: 'receive',
    instruction: 'Send one image or photo. Include the bracketed token as the caption if Messages allows it.'
  },
  {
    id: 'video-media',
    title: 'Inbound video media',
    expectedWebhook: 'receive',
    optional: true,
    instruction: 'Send one short video. Include the bracketed token as the caption if Messages allows it.'
  },
  {
    id: 'audio-or-file-media',
    title: 'Inbound audio or file media',
    expectedWebhook: 'receive',
    optional: true,
    instruction: 'Send one audio message, voice memo, or file attachment. Include the bracketed token if possible.'
  },
  {
    id: 'tapback-heart',
    title: 'Tapback heart',
    expectedWebhook: 'receive',
    instruction: 'React to this instruction bubble with a heart tapback. Do not send a separate text reply.'
  },
  {
    id: 'tapback-thumbs-up',
    title: 'Tapback thumbs up',
    expectedWebhook: 'receive',
    instruction: 'React to this instruction bubble with a thumbs up tapback. Do not send a separate text reply.'
  },
  {
    id: 'tapback-thumbs-down',
    title: 'Tapback thumbs down',
    expectedWebhook: 'receive',
    instruction: 'React to this instruction bubble with a thumbs down tapback. Do not send a separate text reply.'
  },
  {
    id: 'tapback-haha',
    title: 'Tapback haha',
    expectedWebhook: 'receive',
    instruction: 'React to this instruction bubble with a haha tapback. Do not send a separate text reply.'
  },
  {
    id: 'tapback-emphasis',
    title: 'Tapback emphasis',
    expectedWebhook: 'receive',
    instruction: 'React to this instruction bubble with an exclamation/emphasis tapback. Do not send a separate text reply.'
  },
  {
    id: 'tapback-question',
    title: 'Tapback question',
    expectedWebhook: 'receive',
    instruction: 'React to this instruction bubble with a question mark tapback. Do not send a separate text reply.'
  },
  {
    id: 'tapback-custom-emoji',
    title: 'Tapback custom emoji',
    expectedWebhook: 'receive',
    optional: true,
    instruction:
      'React to this instruction bubble with a non-standard emoji Tapback, such as eyes or fire. Do not send a separate text reply.'
  },
  {
    id: 'effect-balloons',
    title: 'Send effect balloons',
    expectedWebhook: 'receive',
    optional: true,
    instruction: 'Send a new message with the balloons screen effect and include the bracketed token in the message.'
  },
  {
    id: 'effect-celebration',
    title: 'Send effect celebration',
    expectedWebhook: 'receive',
    optional: true,
    instruction: 'Send a new message with a celebration/confetti/fireworks effect and include the bracketed token.'
  },
  {
    id: 'group-message',
    title: 'Group message',
    expectedWebhook: 'receive',
    optional: true,
    instruction:
      'From a group thread that includes the Sendblue line, send a message containing the bracketed token.'
  },
  {
    id: 'sms-fallback',
    title: 'SMS fallback',
    expectedWebhook: 'receive',
    optional: true,
    instruction:
      'From a non-iMessage sender or with iMessage disabled, send a message containing the bracketed token.'
  }
];

export function scenarioToken(sessionId: string, scenarioId: string): string {
  return `[sendblue-capture:${sessionId}:${scenarioId}]`;
}

export function formatCapturePrompt(options: {
  scenario: GuidedCaptureScenario;
  sessionId: string;
  index: number;
  total: number;
}): string {
  const token = scenarioToken(options.sessionId, options.scenario.id);
  const optional = options.scenario.optional ? ' Optional scenario.' : '';

  return [
    `Capture ${options.index}/${options.total}: ${options.scenario.title}.${optional}`,
    options.scenario.instruction,
    `Token: ${token}`,
    'To skip this step, reply: skip'
  ].join('\n');
}

export async function sendCapturePrompt(
  env: E2ESetupEnv,
  options: SendCapturePromptOptions,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const response = await fetchImpl(`${env.sendblueApiBaseUrl}/api/send-message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sb-api-key-id': env.sendblueApiKeyId ?? '',
      'sb-api-secret-key': env.sendblueApiSecretKey ?? ''
    },
    body: JSON.stringify({
      number: options.toNumber,
      from_number: env.sendblueFromNumber,
      content: options.content,
      status_callback: options.statusCallback
    })
  });
  const body = await response.json().catch(async () => response.text().catch(() => null));

  if (!response.ok) {
    throw new Error(`Sendblue capture prompt failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}
