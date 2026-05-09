import express from 'express';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { mountAdminRoutes } from '../../src/http/admin.js';
import { InMemoryLimitCounterStore } from '../../src/limits/store.js';
import { createLimitTracker } from '../../src/limits/tracker.js';
import { testConfig } from '../helpers/config.js';

const silentLogger = pino({ level: 'silent' });

describe('mountAdminRoutes', () => {
  it('returns false and does not register a route when adminApiToken is unset', () => {
    const app = express();
    const config = testConfig({ adminApiToken: undefined });
    const tracker = createLimitTracker({
      config,
      store: new InMemoryLimitCounterStore(),
      logger: silentLogger
    });

    const mounted = mountAdminRoutes({ app, config, limitTracker: tracker, logger: silentLogger });
    expect(mounted).toBe(false);

    const stack = (app._router as { stack?: Array<{ route?: { path?: string } }> } | undefined)?.stack ?? [];
    const adminRoutes = stack.filter(layer => layer.route?.path === '/admin/limits');
    expect(adminRoutes).toHaveLength(0);
  });

  it('returns true and registers /admin/limits when adminApiToken is set', () => {
    const app = express();
    const config = testConfig({ adminApiToken: 'tok' });
    const tracker = createLimitTracker({
      config,
      store: new InMemoryLimitCounterStore(),
      logger: silentLogger
    });

    const mounted = mountAdminRoutes({ app, config, limitTracker: tracker, logger: silentLogger });
    expect(mounted).toBe(true);

    const stack = (app._router as { stack?: Array<{ route?: { path?: string } }> } | undefined)?.stack ?? [];
    const adminRoutes = stack.filter(layer => layer.route?.path === '/admin/limits');
    expect(adminRoutes).toHaveLength(1);
  });
});
