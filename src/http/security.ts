import type { Request } from 'express';
import type { AgentConfig } from '../config/env.js';

export function validateWebhookSecret(req: Request, config: AgentConfig): boolean {
  if (!config.sendblueWebhookSecret) return true;

  const expected = config.sendblueWebhookSecret;
  const headerName = config.sendblueWebhookSecretHeader.toLowerCase();
  const actual = req.header(headerName);

  return actual === expected;
}
