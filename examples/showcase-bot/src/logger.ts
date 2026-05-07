export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const entry = {
    at: new Date().toISOString(),
    level,
    source: 'showcase-bot',
    message,
    ...(data !== undefined && { data })
  };
  console.log(JSON.stringify(entry));
}
