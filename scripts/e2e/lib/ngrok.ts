import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { E2ESetupEnv } from './env.js';

export type NgrokTunnel = {
  public_url?: string;
  proto?: string;
};

export function parseNgrokPublicUrl(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const tunnels = (payload as { tunnels?: unknown }).tunnels;
  if (!Array.isArray(tunnels)) return undefined;

  const tunnel = tunnels.find((candidate): candidate is NgrokTunnel => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const url = (candidate as NgrokTunnel).public_url;
    return typeof url === 'string' && url.startsWith('https://');
  });

  return tunnel?.public_url?.replace(/\/+$/, '');
}

export function checkNgrokCommand(bin: string): { ok: boolean; error?: string } {
  const result = spawnSync(bin, ['version'], { encoding: 'utf8' });
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    error: result.error?.message || result.stderr || `${bin} version exited with ${result.status}`
  };
}

export function startNgrok(env: E2ESetupEnv): ChildProcess {
  const args = ['http', String(env.agentPort), '--log=stdout'];
  if (env.ngrokDomain) {
    args.push('--domain', env.ngrokDomain);
  }

  return spawn(env.ngrokBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NGROK_AUTHTOKEN: env.ngrokAuthtoken ?? process.env.NGROK_AUTHTOKEN ?? ''
    }
  });
}

export async function getNgrokPublicUrl(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
  const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/tunnels`);
  if (!response.ok) {
    throw new Error(`ngrok local API returned HTTP ${response.status}`);
  }
  return parseNgrokPublicUrl(await response.json());
}

export async function waitForNgrokPublicUrl(
  apiUrl: string,
  options: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 250;
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      const url = await getNgrokPublicUrl(apiUrl, options.fetchImpl ?? fetch);
      if (url) return url;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ngrok public URL${suffix}`);
}
