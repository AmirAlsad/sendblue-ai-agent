import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type pino from 'pino';

/**
 * Request-scoped correlation context. The traceId originates at webhook ingest
 * and is propagated through the conversation/outbound/status pipeline. When a
 * status callback arrives later, the agent can recover the original trace from
 * the outbound handle mapping and chain both into the child logger.
 */
export type RequestContext = {
  traceId: string;
  logger: pino.Logger;
};

declare module 'express-serve-static-core' {
  interface Locals {
    traceId?: string;
    requestLogger?: pino.Logger;
  }
}

const TRACE_HEADER = 'x-trace-id';
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Express middleware that generates (or accepts) a request-scoped traceId and a
 * pino child logger. Stores both on `res.locals` so handlers can pluck them
 * via `requestContextFromLocals(res)` and pass into agent calls.
 */
export function traceMiddleware(deps: { logger: pino.Logger }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header(TRACE_HEADER);
    const traceId =
      inbound && TRACE_ID_PATTERN.test(inbound.trim()) ? inbound.trim() : randomUUID();
    res.locals.traceId = traceId;
    res.locals.requestLogger = deps.logger.child({ traceId, route: req.path });
    res.setHeader(TRACE_HEADER, traceId);
    next();
  };
}

/** Pull the request-scoped context off `res.locals` for agent calls. */
export function requestContextFromLocals(res: Response): RequestContext | undefined {
  const traceId = res.locals.traceId;
  const logger = res.locals.requestLogger;
  if (typeof traceId === 'string' && logger) return { traceId, logger };
  return undefined;
}
