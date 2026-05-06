import type { Express } from 'express';
import httpMocks from 'node-mocks-http';

type DispatchOptions = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type DispatchResponse = {
  status: number;
  headers: Record<string, string | number | string[]>;
  text: string;
  body: unknown;
};

export async function dispatch(app: Express, options: DispatchOptions): Promise<DispatchResponse> {
  const req = httpMocks.createRequest({
    method: options.method as never,
    url: options.path,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers
    },
    body: options.body as never
  });
  const res = httpMocks.createResponse({ eventEmitter: (await import('node:events')).EventEmitter });

  await new Promise<void>((resolve, reject) => {
    res.on('end', resolve);
    res.on('error', reject);
    app(req, res);
  });

  const text = res._getData();
  let body: unknown = text;
  if (typeof text === 'string' && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return {
    status: res.statusCode,
    headers: res._getHeaders(),
    text: typeof text === 'string' ? text : String(text),
    body
  };
}
