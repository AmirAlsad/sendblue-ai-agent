import type { Express } from 'express';
import type { CapturedWebhookEnvelope } from '../../scripts/e2e/lib/capture-server.js';
import { dispatch } from './dispatch.js';

export async function replayCapturedEnvelope(app: Express, envelope: CapturedWebhookEnvelope) {
  const headers = Object.fromEntries(
    Object.entries(envelope.headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase()))
  );

  return dispatch(app, {
    method: 'POST',
    path: envelope.path,
    headers,
    body: envelope.body
  });
}
