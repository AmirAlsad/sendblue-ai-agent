import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, '../fixtures');

export function loadFixture<T = unknown>(relativePath: string): T {
  const fullPath = resolve(fixtureRoot, relativePath);
  return JSON.parse(readFileSync(fullPath, 'utf8')) as T;
}
