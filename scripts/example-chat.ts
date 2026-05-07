/**
 * `npm run example:chat -- <example-name>`
 *
 * Boots one of the chat examples in a child process, waits for it to be
 * healthy, then drops into a REPL that POSTs each line to /chat and
 * pretty-prints the response. No Sendblue, no ngrok, no agent.
 *
 * The simplest possible "clone the repo, give your credentials, talk to
 * the bot" path. For the full hardware loop (real iMessage device, real
 * Sendblue line, real webhooks), use `npm run dev:e2e`.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

interface ExampleSpec {
  name: string;
  port: number;
  dir: string;
  command: string;
  args: string[];
  /** If true, run `npm install` in the example dir if node_modules is missing. */
  needsInstall?: boolean;
  /** Env vars that must be set in either process.env or the example's .env. */
  requiredEnv?: string[];
  /** Description shown in --help and on boot. */
  description: string;
  /** Notable parameters worth telling the user about. */
  hints?: string[];
}

const EXAMPLES: Record<string, ExampleSpec> = {
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
      'Try: `silence`, `multi`, `react`, `reply`, `media`, `effect`, `group`, `downgrade`.',
      'Type `/sms on` to toggle simulated SMS downgrade and see iMessage-only fallbacks.'
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

function parseArgs(argv: string[]): { example?: string; help: boolean; raw: boolean } {
  const args = argv.slice(2);
  const out: { example?: string; help: boolean; raw: boolean } = { help: false, raw: false };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--raw') out.raw = true;
    else if (!arg.startsWith('-') && !out.example) out.example = arg;
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: npm run example:chat -- <example-name> [--raw]

Examples:
${Object.values(EXAMPLES)
  .map(e => `  ${e.name.padEnd(24)} ${e.description}`)
  .join('\n')}

Flags:
  --raw    Print full JSON response in addition to the pretty summary.
  --help   Show this message.

Once running, type a message and press enter. Special commands:
  /help          Show this list
  /sms on|off    Toggle simulated SMS-downgraded conversation
  /reset         Generate a fresh conversationKey (clears bot memory)
  /raw           Toggle raw JSON output
  /exit          Quit
`);
}

function loadExampleEnv(spec: ExampleSpec): Record<string, string> {
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
      // Strip a trailing inline comment (` # ...`) on unquoted values so users
      // who annotate their .env don't end up with the comment text in the value.
      const hashIdx = value.indexOf(' #');
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trimEnd();
    }
    if (value !== '') result[match[1]!] = value;
  }
  return result;
}

function checkRequiredEnv(spec: ExampleSpec): string[] {
  if (!spec.requiredEnv) return [];
  const fromFile = loadExampleEnv(spec);
  return spec.requiredEnv.filter(key => !process.env[key] && !fromFile[key]);
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
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

function ensureInstalled(spec: ExampleSpec): Promise<void> {
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

function spawnExample(spec: ExampleSpec): ChildProcess {
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

interface SessionState {
  conversationKey: string;
  fromNumber: string;
  toNumber: string;
  smsDowngraded: boolean;
  raw: boolean;
}

function freshSession(): SessionState {
  const digits = Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0');
  const fromNumber = `+1555000${digits}`;
  return {
    conversationKey: `direct:+15553334444:${fromNumber}`,
    fromNumber,
    toNumber: '+15553334444',
    smsDowngraded: false,
    raw: false
  };
}

let messageCounter = 0;
function nextHandle(): string {
  messageCounter += 1;
  return `m-${Date.now()}-${messageCounter}`;
}

function buildChatRequest(state: SessionState, text: string) {
  const handle = nextHandle();
  const channel = state.smsDowngraded ? 'sms' : 'imessage';
  return {
    message: text,
    fromNumber: state.fromNumber,
    toNumber: state.toNumber,
    messageHandle: handle,
    channel,
    messages: [
      {
        content: text,
        fromNumber: state.fromNumber,
        toNumber: state.toNumber,
        messageHandle: handle,
        channel,
        mediaUrl: null,
        messageType: null,
        sendStyle: null,
        raw: {}
      }
    ],
    conversation: {
      key: state.conversationKey,
      type: 'direct',
      lineNumber: state.toNumber,
      phoneNumber: state.fromNumber,
      groupId: null,
      groupDisplayName: null,
      participants: null,
      channel,
      smsDowngraded: state.smsDowngraded,
      state: 'active'
    },
    sendblue: {
      wasDowngraded: state.smsDowngraded,
      service: state.smsDowngraded ? 'SMS' : 'iMessage',
      mediaUrl: null,
      groupId: null,
      groupDisplayName: null,
      sendblueNumber: state.toNumber,
      participants: null,
      sendStyle: null,
      messageType: null,
      raw: {}
    }
  };
}

interface ChatAction {
  type: string;
  content?: string;
  mediaUrl?: string;
  reaction?: string;
  target?: { messageHandle?: string; alias?: string };
  sendStyle?: string;
}

interface ChatResponse {
  message?: string;
  messages?: string[];
  silence?: boolean;
  actions?: ChatAction[];
  warnings?: Array<{ code: string; message: string }>;
  error?: string;
}

function renderAction(action: ChatAction): string {
  switch (action.type) {
    case 'message': {
      const effect = action.sendStyle ? ` [${action.sendStyle}]` : '';
      const media = action.mediaUrl ? `\n  └─ media: ${action.mediaUrl}` : '';
      return `  message${effect}: ${action.content ?? ''}${media}`;
    }
    case 'media':
      return `  media: ${action.mediaUrl}${action.content ? `\n  caption: ${action.content}` : ''}`;
    case 'reaction':
      return `  reaction: ${action.reaction} → ${action.target?.messageHandle ?? action.target?.alias ?? '?'}`;
    case 'reply':
      return `  reply → ${action.target?.messageHandle ?? action.target?.alias ?? '?'}: ${action.content ?? ''}`;
    case 'silence':
      return `  silence`;
    default:
      return `  ${action.type}: ${JSON.stringify(action)}`;
  }
}

function renderResponse(response: ChatResponse, state: SessionState): void {
  if (response.error) {
    console.log(`  ✖ error: ${response.error}`);
    return;
  }
  if (response.silence === true && (!response.actions || response.actions.length === 0)) {
    console.log(`  ─ silence`);
  } else if (Array.isArray(response.actions) && response.actions.length > 0) {
    for (const action of response.actions) console.log(renderAction(action));
  } else if (typeof response.message === 'string') {
    console.log(`  message: ${response.message}`);
  } else if (Array.isArray(response.messages)) {
    for (const msg of response.messages) console.log(`  message: ${msg}`);
  } else {
    console.log('  (empty response)');
  }
  if (response.warnings && response.warnings.length > 0) {
    for (const w of response.warnings) console.log(`  ! ${w.code}: ${w.message}`);
  }
  if (state.raw) console.log(`  raw: ${JSON.stringify(response)}`);
}

function printIntro(spec: ExampleSpec, state: SessionState): void {
  console.log('');
  console.log(`▶ ${spec.name} on http://localhost:${spec.port}/chat`);
  console.log(`  ${spec.description}`);
  if (spec.hints) for (const hint of spec.hints) console.log(`  • ${hint}`);
  console.log(`  conversationKey: ${state.conversationKey} (${state.smsDowngraded ? 'sms-downgraded' : 'imessage'})`);
  console.log(`  type a message and press enter. /help for commands. ctrl-c to quit.`);
  console.log('');
}

function applyCommand(input: string, state: SessionState): boolean {
  const [cmd, ...rest] = input.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case 'sms':
      if (rest[0] === 'on') state.smsDowngraded = true;
      else if (rest[0] === 'off') state.smsDowngraded = false;
      else state.smsDowngraded = !state.smsDowngraded;
      console.log(`  smsDowngraded: ${state.smsDowngraded}`);
      return true;
    case 'reset': {
      const fresh = freshSession();
      state.conversationKey = fresh.conversationKey;
      state.fromNumber = fresh.fromNumber;
      console.log(`  new conversationKey: ${state.conversationKey}`);
      return true;
    }
    case 'raw':
      state.raw = !state.raw;
      console.log(`  raw output: ${state.raw}`);
      return true;
    case 'help':
      console.log('  commands: /help, /sms on|off, /reset, /raw, /exit');
      return true;
    case 'exit':
    case 'quit':
      process.kill(process.pid, 'SIGINT');
      return true;
    default:
      console.log(`  unknown command: ${cmd}`);
      return true;
  }
}

async function chatLoop(spec: ExampleSpec, state: SessionState): Promise<void> {
  const isTty = process.stdin.isTTY;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: isTty ? '> ' : ''
  });
  let closed = false;
  rl.once('close', () => {
    closed = true;
  });
  const prompt = () => {
    if (!isTty || closed) return;
    try {
      rl.prompt();
    } catch {
      // readline can race-close after the last line; ignore.
    }
  };
  prompt();
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === '') {
      prompt();
      continue;
    }
    if (line.startsWith('/')) {
      applyCommand(line, state);
      prompt();
      continue;
    }
    if (!isTty) console.log(`> ${line}`);
    try {
      const res = await fetch(`http://localhost:${spec.port}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildChatRequest(state, line))
      });
      const json = (await res.json().catch(() => ({}))) as ChatResponse;
      if (!res.ok) console.log(`  ✖ HTTP ${res.status}`);
      renderResponse(json, state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✖ request failed: ${msg}`);
    }
    prompt();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || !args.example) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const spec = EXAMPLES[args.example];
  if (!spec) {
    console.error(`unknown example: ${args.example}`);
    console.error(`available: ${Object.keys(EXAMPLES).join(', ')}`);
    process.exit(1);
  }

  const missing = checkRequiredEnv(spec);
  if (missing.length > 0) {
    console.error(`missing required env: ${missing.join(', ')}`);
    console.error(`set them in ${spec.dir}/.env or in your shell. see ${spec.dir}/.env.example`);
    process.exit(1);
  }

  if (spec.needsInstall) {
    await ensureInstalled(spec);
  }

  const child = spawnExample(spec);
  let exiting = false;
  const cleanupAndExit = async (signal: NodeJS.Signals, code: number) => {
    if (exiting) return;
    exiting = true;
    if (!child.killed) child.kill(signal);
    // Wait for the child to actually exit before returning so piped/CI usage
    // doesn't orphan the example server in its own process group.
    await new Promise<void>(resolveFn => {
      if (child.exitCode !== null) return resolveFn();
      const timeout = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolveFn();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveFn();
      });
    });
    process.exit(code);
  };
  process.on('SIGINT', () => void cleanupAndExit('SIGINT', 0));
  process.on('SIGTERM', () => void cleanupAndExit('SIGTERM', 0));
  child.on('exit', code => {
    if (!exiting && code !== 0 && code !== null) {
      console.error(`example exited with code ${code}`);
      process.exit(code);
    }
  });

  try {
    await waitForHealth(spec.port);
  } catch (err) {
    console.error((err as Error).message);
    await cleanupAndExit('SIGTERM', 1);
  }

  const state: SessionState = { ...freshSession(), raw: args.raw };
  printIntro(spec, state);
  await chatLoop(spec, state);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
