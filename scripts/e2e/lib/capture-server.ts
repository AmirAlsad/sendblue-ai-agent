import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { CAPTURE_MANAGED_WEBHOOK_TYPES, sendblueWebhookPath } from '../../../src/sendblue/webhook-types.js';

export type CapturedWebhookEnvelope = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  receivedAt: string;
  path: string;
  sequence: number;
  capture?: Record<string, unknown>;
};

export type CaptureServerOptions = {
  port: number;
  outputDir?: string;
  metadata?: () => Record<string, unknown> | undefined;
  onCapture?: (envelope: CapturedWebhookEnvelope) => void;
};

export type StartedCaptureServer = {
  url: string;
  outputDir: string;
  envelopes: CapturedWebhookEnvelope[];
  close(): Promise<void>;
};

export async function createSendblueCaptureApp(outputDir: string): Promise<{
  app: express.Express;
  envelopes: CapturedWebhookEnvelope[];
}>;
export async function createSendblueCaptureApp(
  outputDir: string,
  options: Pick<CaptureServerOptions, 'metadata' | 'onCapture'>
): Promise<{
  app: express.Express;
  envelopes: CapturedWebhookEnvelope[];
}>;
export async function createSendblueCaptureApp(
  outputDir: string,
  options?: Pick<CaptureServerOptions, 'metadata' | 'onCapture'>
): Promise<{
  app: express.Express;
  envelopes: CapturedWebhookEnvelope[];
}> {
  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true });

  const app = express();
  const envelopes: CapturedWebhookEnvelope[] = [];
  let sequence = 0;
  app.use(express.raw({ limit: '5mb', type: '*/*' }));

  app.post(CAPTURE_MANAGED_WEBHOOK_TYPES.map(sendblueWebhookPath), async (req, res) => {
    const metadata = options?.metadata?.();
    sequence += 1;
    const envelope: CapturedWebhookEnvelope = {
      headers: req.headers,
      body: parseBody(req.body),
      receivedAt: new Date().toISOString(),
      path: req.path,
      sequence,
      ...(metadata ? { capture: metadata } : {})
    };
    envelopes.push(envelope);
    await writeCapture(resolvedOutputDir, envelope);
    res.status(202).json({ ok: true, captured: envelopes.length });
    options?.onCapture?.(envelope);
  });

  return { app, envelopes };
}

export async function startSendblueCaptureServer(
  options: CaptureServerOptions
): Promise<StartedCaptureServer> {
  const outputDir = resolve(options.outputDir || '.captures/sendblue');
  const { app, envelopes } = await createSendblueCaptureApp(outputDir, options);
  const server = await listen(app, options.port);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    url: `http://127.0.0.1:${port}`,
    outputDir,
    envelopes,
    close: () => closeServer(server)
  };
}

async function writeCapture(outputDir: string, envelope: CapturedWebhookEnvelope): Promise<void> {
  const safePath = envelope.path.replace(/^\/+/, '').replaceAll('/', '-') || 'root';
  const scenario = typeof envelope.capture?.scenarioId === 'string' ? `${safeSegment(envelope.capture.scenarioId)}-` : '';
  const sequence = String(envelope.sequence).padStart(4, '0');
  const filename = `${envelope.receivedAt.replaceAll(/[:.]/g, '-')}-${sequence}-${scenario}${safePath}.json`;
  await writeFile(resolve(outputDir, filename), `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600
  });
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, '-').replaceAll(/-+/g, '-');
}

function parseBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  const raw = body.toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
