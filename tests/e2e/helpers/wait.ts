export async function waitFor<T>(
  predicate: () => T | undefined | false | Promise<T | undefined | false>,
  options: { timeoutMs: number; intervalMs?: number; label: string }
): Promise<T> {
  const start = Date.now();
  const intervalMs = options.intervalMs ?? 250;
  let lastError: unknown;

  while (Date.now() - start < options.timeoutMs) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${options.label}${suffix}`);
}
