export type { SttProvider, SttResult } from './types.js';
import type { SttProvider } from './types.js';
import { createGroqProvider } from './groq.js';

export function createSttProvider(): SttProvider | null {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) return createGroqProvider(groqKey);
  return null;
}
