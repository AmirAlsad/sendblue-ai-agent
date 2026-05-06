import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AgentConfig } from '../config/env.js';

/**
 * Validates the Sendblue webhook shared-secret header on an inbound request.
 *
 * Sendblue's documented behavior (https://docs.sendblue.com/security): "Sendblue
 * sends `sb-signing-secret` header with requests. Verify this matches your
 * configured secret." The signing scheme is a literal shared-secret string
 * comparison, not an HMAC signature over the request body.
 *
 * We accept both the configured `SENDBLUE_WEBHOOK_SECRET_HEADER` (defaults to
 * `sb-signing-secret`) and the documented `sb-signing-secret` literal so that
 * captured legacy installations and the documented header both work without
 * reconfiguration.
 *
 * Comparison is constant-time to avoid leaking secret prefixes to a remote
 * attacker that can choose header values and observe response timing.
 *
 * Returns `true` when:
 * - no secret is configured (validation disabled), or
 * - any accepted header on the request matches the configured secret.
 */
export function validateWebhookSecret(req: Request, config: AgentConfig): boolean {
  if (!config.sendblueWebhookSecret) return true;

  const expected = config.sendblueWebhookSecret;
  const headerNames = new Set([
    config.sendblueWebhookSecretHeader.toLowerCase(),
    'sb-signing-secret'
  ]);

  for (const headerName of headerNames) {
    const provided = req.header(headerName);
    if (provided && constantTimeStringEquals(provided, expected)) {
      return true;
    }
  }

  return false;
}

function constantTimeStringEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // timingSafeEqual requires equal-length buffers. Compare against `bufferA`
    // itself so we still spend timingSafeEqual time and never short-circuit.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
