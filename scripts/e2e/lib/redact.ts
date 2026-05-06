const SECRET_KEY_RE = /(SECRET|PASSWORD|TOKEN|KEY|AUTHTOKEN)/i;

export function redactValue(key: string, value: string | undefined): string {
  if (!value) return '';
  if (!SECRET_KEY_RE.test(key)) return value;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, redactValue(key, value)])
  );
}
