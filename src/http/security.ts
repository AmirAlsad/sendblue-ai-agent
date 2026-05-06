import type { Request } from 'express';
import type { AgentConfig } from '../config/env.js';

export function validateWebhookSecret(req: Request, config: AgentConfig): boolean {
  if (!config.sendblueWebhookSecret) return true;

  const expected = config.sendblueWebhookSecret;
  const headerNames = new Set([
    config.sendblueWebhookSecretHeader.toLowerCase(),
    'sb-signing-secret'
  ]);

  return [...headerNames].some(headerName => req.header(headerName) === expected);
}
