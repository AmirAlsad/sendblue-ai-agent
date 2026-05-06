import { forward, type Config, type Listener } from '@ngrok/ngrok';
import type { E2ESetupEnv } from './env.js';

export type NgrokForwarder = (config: Config) => Promise<Pick<Listener, 'url' | 'close'>>;

export type StartedNgrokTunnel = {
  publicUrl: string;
  close(): Promise<void>;
};

export function buildNgrokConfig(env: E2ESetupEnv): Config {
  if (!env.ngrokAuthtoken) {
    throw new Error('Missing required ngrok environment variable: NGROK_AUTHTOKEN');
  }

  return {
    addr: env.agentPort,
    authtoken: env.ngrokAuthtoken,
    ...(env.ngrokDomain ? { domain: env.ngrokDomain } : {})
  };
}

export async function startNgrokTunnel(
  env: E2ESetupEnv,
  forwarder: NgrokForwarder = forward
): Promise<StartedNgrokTunnel> {
  const listener = await forwarder(buildNgrokConfig(env));
  const publicUrl = normalizeNgrokUrl(listener.url());

  if (!publicUrl) {
    await listener.close();
    throw new Error('ngrok SDK did not return an HTTPS public URL');
  }

  return {
    publicUrl,
    close: () => listener.close()
  };
}

export function normalizeNgrokUrl(url: string | null): string | undefined {
  if (!url) return undefined;
  const normalized = url.replace(/\/+$/, '');
  return normalized.startsWith('https://') ? normalized : undefined;
}
