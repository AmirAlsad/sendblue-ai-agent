/**
 * Shared example registry + spawn/lifecycle helpers used by both the local
 * `npm run example:chat` REPL and the hardware-loop `npm run example:dev`
 * runner.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(__filename), '..', '..');

export interface ExampleSpec {
  name: string;
  port: number;
  dir: string;
  command: string;
  args: string[];
  /** If true, run `npm install` in the example dir if node_modules is missing. */
  needsInstall?: boolean;
  /** Env vars that must be set in either process.env or the example's .env. */
  requiredEnv?: string[];
  description: string;
  hints?: string[];
}

export const EXAMPLES: Record<string, ExampleSpec> = {
  'minimal-chat-endpoint': {
    name: 'minimal-chat-endpoint',
    port: 4001,
    dir: 'examples/minimal-chat-endpoint',
    command: 'node',
    args: ['server.js'],
    description: 'Smallest possible echo bot.',
    hints: ['Type `silence` to see the silence path.']
  },
  'action-catalog': {
    name: 'action-catalog',
    port: 4003,
    dir: 'examples/action-catalog',
    command: 'node',
    args: ['server.js'],
    description: 'One handler per chat action type.',
    hints: [
      'Try: `silence`, `multi`, `react`, `reply`, `media`, `effect`, `typing`, `group`, `downgrade`.',
      'Send `help <keyword>` to ask the bot what each keyword does before triggering it.',
      'Type `/sms on` (REPL only) to toggle simulated SMS downgrade and see iMessage-only fallbacks.'
    ]
  },
  'scripted-flow': {
    name: 'scripted-flow',
    port: 4005,
    dir: 'examples/scripted-flow',
    command: 'node',
    args: ['server.js'],
    description: 'Pizza pickup state machine. Walks through every action type as a real conversation arc.',
    hints: ['Type any greeting to start, then a size, toppings, your name, and "here" on arrival.']
  },
  'showcase-bot': {
    name: 'showcase-bot',
    port: 4006,
    dir: 'examples/showcase-bot',
    command: 'npm',
    args: ['start', '--silent'],
    needsInstall: true,
    requiredEnv: ['ANTHROPIC_API_KEY'],
    description: 'LLM-backed bot via Vercel AI SDK. The model decides which actions to call.',
    hints: [
      'Try: `tell me a joke`, `react to my last message with a heart`, `send me an image of a beach`.',
      'Conversation history is per-conversation-key; type `/reset` to start fresh.'
    ]
  }
};

export function exampleNames(): string[] {
  return Object.keys(EXAMPLES);
}

export function loadExampleEnv(spec: ExampleSpec): Record<string, string> {
  const envPath = resolve(REPO_ROOT, spec.dir, '.env');
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2]!;
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.indexOf(' #');
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trimEnd();
    }
    if (value !== '') result[match[1]!] = value;
  }
  return result;
}

export function checkRequiredEnv(spec: ExampleSpec): string[] {
  if (!spec.requiredEnv) return [];
  const fromFile = loadExampleEnv(spec);
  return spec.requiredEnv.filter(key => !process.env[key] && !fromFile[key]);
}

export function ensureInstalled(spec: ExampleSpec): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const dir = resolve(REPO_ROOT, spec.dir);
    if (existsSync(resolve(dir, 'node_modules'))) {
      resolveFn();
      return;
    }
    console.log(`> installing dependencies in ${spec.dir}...`);
    const install = spawn('npm', ['install', '--silent'], { cwd: dir, stdio: 'inherit' });
    install.on('exit', code => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`npm install failed with exit code ${code}`));
    });
  });
}

export function spawnExample(spec: ExampleSpec): ChildProcess {
  const dir = resolve(REPO_ROOT, spec.dir);
  const child = spawn(spec.command, spec.args, {
    cwd: dir,
    env: { ...process.env, PORT: String(spec.port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout?.on('data', chunk => process.stderr.write(`  [${spec.name}] ${chunk}`));
  child.stderr?.on('data', chunk => process.stderr.write(`  [${spec.name}] ${chunk}`));
  return child;
}

export async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`example did not become healthy on port ${port}: ${lastErr}`);
}

/**
 * Kill a child process and wait for it to actually exit. Falls back to
 * SIGKILL after `graceMs` so we never orphan the example server in CI/piped
 * usage.
 */
export async function killChildAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  graceMs = 3_000
): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill(signal);
  await new Promise<void>(resolveFn => {
    if (child.exitCode !== null) return resolveFn();
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolveFn();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveFn();
    });
  });
}
