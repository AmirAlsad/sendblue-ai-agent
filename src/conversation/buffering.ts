import type { AgentConfig } from '../config/env.js';

export function calculateBufferTimeout(
  messageCount: number,
  config: Pick<
    AgentConfig,
    'bufferBaseTimeoutMs' | 'bufferGrowthFactor' | 'bufferMaxTimeoutMs' | 'bufferNoiseMaxDeviation'
  >,
  random: () => number = Math.random
): number {
  const calculated = config.bufferBaseTimeoutMs * Math.pow(config.bufferGrowthFactor, messageCount - 1);
  const capped = Math.min(calculated, config.bufferMaxTimeoutMs);

  if (config.bufferNoiseMaxDeviation === 0 || capped === 0) return Math.round(capped);

  const noiseRange = capped * config.bufferNoiseMaxDeviation;
  const noise = (random() * 2 - 1) * noiseRange;
  const min = config.bufferBaseTimeoutMs * 0.5;
  const max = config.bufferMaxTimeoutMs * 1.5;

  return Math.round(Math.max(min, Math.min(capped + noise, max)));
}

export function truncateCancelledMessage(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}...`;
}
