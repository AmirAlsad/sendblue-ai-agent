import express from 'express';
import type { Server } from 'node:http';

export type StartedServer = {
  url: string;
  close(): Promise<void>;
};

export async function startDeterministicChatEndpoint(): Promise<StartedServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.post('/chat', (req, res) => {
    const message = String(req.body?.message ?? '');
    const match = /\[sendblue-e2e:([^\]]+)\]/.exec(message);
    const id = match?.[1] ?? 'manual';
    res.json({ message: `[sendblue-e2e-reply:${id}] received` });
  });

  const server = await listen(app, 0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/chat`,
    close: () => closeServer(server)
  };
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
