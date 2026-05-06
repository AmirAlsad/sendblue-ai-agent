import { execFile, spawnSync } from 'node:child_process';
import { existsSync, constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLE_EPOCH_UNIX_MS = 978307200000;
const NS_PER_MS = 1_000_000n;

export type SendTestIMessageOptions = {
  to: string;
  content: string;
  osascriptBin?: string;
};

export type PollMessagesDbOptions = {
  from: string;
  contains: string;
  since: number | Date;
  timeoutMs?: number;
  intervalMs?: number;
  dbPath?: string;
  sqliteBin?: string;
};

export type NativePrerequisiteCheck = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};

type DbReplyRow = {
  rowid?: number;
  date?: number | string;
  text?: string | null;
  attributedBodyHex?: string | null;
  handleId?: string | null;
};

export function appleDateFromUnixMs(value: number | Date): bigint {
  const unixMs = value instanceof Date ? value.getTime() : value;
  return BigInt(unixMs - APPLE_EPOCH_UNIX_MS) * NS_PER_MS;
}

export function unixMsFromAppleDate(value: bigint | number | string): number {
  const appleDate = typeof value === 'bigint' ? value : BigInt(value);
  return Number(appleDate / NS_PER_MS) + APPLE_EPOCH_UNIX_MS;
}

export function resolveMessagesDbPath(path = process.env.E2E_MESSAGES_DB_PATH): string {
  const raw = path || '~/Library/Messages/chat.db';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

export function buildSendIMessageCommand(options: SendTestIMessageOptions): {
  command: string;
  args: string[];
} {
  return {
    command: options.osascriptBin || 'osascript',
    args: ['-e', sendIMessageAppleScript(options.to, options.content)]
  };
}

export async function sendTestIMessage(options: SendTestIMessageOptions): Promise<void> {
  assertMacOs();
  const { command, args } = buildSendIMessageCommand(options);
  await execFileText(command, args, { timeoutMs: 15000 });
}

export function buildMessagesReplyQuery(options: {
  from: string;
  contains: string;
  since: number | Date;
}): string {
  const sinceAppleDate = appleDateFromUnixMs(options.since);
  return `
SELECT
  message.ROWID AS rowid,
  message.date AS date,
  handle.id AS handleId,
  message.text AS text,
  hex(message.attributedBody) AS attributedBodyHex
FROM message
JOIN handle ON message.handle_id = handle.ROWID
WHERE message.is_from_me = 0
  AND message.date >= ${sinceAppleDate.toString()}
  AND (
    message.text LIKE ${sqliteLikeContainsLiteral(options.contains)} ESCAPE '\\'
    OR (message.text IS NULL AND message.attributedBody IS NOT NULL)
  )
ORDER BY message.date ASC
LIMIT 200;`.trim();
}

export async function pollMessagesDbForReply(
  options: PollMessagesDbOptions
): Promise<{ text: string; unixMs: number; row: DbReplyRow }> {
  assertMacOs();
  const dbPath = resolveMessagesDbPath(options.dbPath);
  await assertReadableMessagesDb(dbPath);

  const timeoutMs = options.timeoutMs ?? 90000;
  const intervalMs = options.intervalMs ?? 1000;
  const start = Date.now();
  let lastAttributedBodyRow: DbReplyRow | undefined;
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const rows = await queryMessagesDb({
        dbPath,
        sqliteBin: options.sqliteBin || 'sqlite3',
        from: options.from,
        contains: options.contains,
        since: options.since
      });

      const textRows = rows
        .map(row => ({ row, text: textFromMessagesRow(row, options.contains) }))
        .filter((match): match is { row: DbReplyRow; text: string } => Boolean(match.text));
      const textRow =
        textRows.find(match => handlesMatch(match.row.handleId, options.from)) ?? textRows[0];

      if (textRow && textRow.row.date !== undefined) {
        return {
          text: textRow.text,
          unixMs: unixMsFromAppleDate(textRow.row.date),
          row: textRow.row
        };
      }

      lastAttributedBodyRow = rows.find(row => row.attributedBodyHex && handlesMatch(row.handleId, options.from));
    } catch (error) {
      lastError = error;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  if (lastAttributedBodyRow) {
    throw new Error(
      'Timed out waiting for reply text. A matching Messages row had attributedBody but no text; add an attributedBody decoder fallback if this host stores replies that way.'
    );
  }

  const suffix = lastError instanceof Error ? ` Last sqlite3 error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for Messages.app reply containing "${options.contains}".${suffix}`);
}

export async function checkNativeMessagesPrerequisites(
  dbPath = resolveMessagesDbPath()
): Promise<NativePrerequisiteCheck> {
  const checks: NativePrerequisiteCheck['checks'] = [];

  checks.push({
    name: 'macOS host',
    ok: process.platform === 'darwin',
    detail: process.platform
  });
  checks.push(checkCommand('osascript', ['-e', 'return 1']));
  checks.push(checkCommand('sqlite3', ['-version']));

  try {
    await assertReadableMessagesDb(dbPath);
    checks.push({ name: 'Messages database readable', ok: true, detail: dbPath });
  } catch (error) {
    checks.push({
      name: 'Messages database readable',
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  }

  return { ok: checks.every(check => check.ok), checks };
}

export async function assertNativeMessagesPrerequisites(dbPath?: string): Promise<void> {
  const result = await checkNativeMessagesPrerequisites(dbPath);
  if (!result.ok) {
    const failed = result.checks
      .filter(check => !check.ok)
      .map(check => `${check.name}${check.detail ? ` (${check.detail})` : ''}`)
      .join(', ');
    throw new Error(`Native macOS E2E prerequisites failed: ${failed}`);
  }
}

async function queryMessagesDb(options: {
  dbPath: string;
  sqliteBin: string;
  from: string;
  contains: string;
  since: number | Date;
}): Promise<DbReplyRow[]> {
  const sql = buildMessagesReplyQuery(options);
  const { stdout } = await execFileText(options.sqliteBin, ['-readonly', '-json', options.dbPath, sql], {
    timeoutMs: 5000
  });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? (parsed as DbReplyRow[]) : [];
}

async function assertReadableMessagesDb(dbPath: string): Promise<void> {
  if (!existsSync(dbPath)) {
    throw new Error(`Messages database does not exist at ${dbPath}`);
  }
  await access(dbPath, constants.R_OK);
}

function assertMacOs(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Native real-device E2E requires macOS with Messages.app configured');
  }
}

function checkCommand(command: string, args: string[]): { name: string; ok: boolean; detail?: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    name: `${command} available`,
    ok: result.status === 0,
    detail: result.error?.message || result.stderr.trim() || undefined
  };
}

function sendIMessageAppleScript(to: string, content: string): string {
  return `
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy ${appleScriptStringLiteral(to)} of targetService
  send ${appleScriptStringLiteral(content)} to targetBuddy
end tell`.trim();
}

function appleScriptStringLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqliteLikeContainsLiteral(value: string): string {
  return sqliteStringLiteral(`%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
}

function textFromMessagesRow(row: DbReplyRow, contains: string): string | undefined {
  if (typeof row.text === 'string' && row.text.includes(contains)) return row.text;
  if (!row.attributedBodyHex) return undefined;

  const decoded = Buffer.from(row.attributedBodyHex, 'hex').toString('utf8');
  return decoded.includes(contains) ? decoded : undefined;
}

function handlesMatch(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  if (actual === expected) return true;

  const actualDigits = digitsOnly(actual);
  const expectedDigits = digitsOnly(expected);
  if (!actualDigits || !expectedDigits) return false;

  return actualDigits === expectedDigits || actualDigits.endsWith(expectedDigits) || expectedDigits.endsWith(actualDigits);
}

function digitsOnly(value: string): string {
  return value.replaceAll(/\D/g, '');
}

function execFileText(
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: options.timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${command} failed: ${error.message}${typeof stderr === 'string' && stderr ? `\n${stderr}` : ''}`
          )
        );
        return;
      }

      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
