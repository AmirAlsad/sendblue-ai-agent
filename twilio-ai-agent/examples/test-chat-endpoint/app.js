// Programmable test chat endpoint for twilio-ai-agent integration tests.
//
// Two factories: createStore() and createApp({ store }). Tests can either
// spawn this as a standalone server (see server.js) and drive it via the
// `/_admin/*` HTTP API, or import these factories directly and drive the
// store via JS calls (see tests/integration/helpers/chat-endpoint.js).
//
// Behavior precedence per /chat request:
//   1. The first matching rule (in insertion order). Rules can be `once: true`.
//   2. The next entry on the script queue (FIFO).
//   3. The default behavior (echo by default).
//
// Each scripted/rule "response" object can be a normalized `Response` (see
// normalizeResponse below) or a shorthand. Shorthands handled:
//   { messages: [...] }              → JSON body { success: true, messages }
//   { silence: true }                → JSON body { success: true, silence: true }
//   { fallbackMessage: '...' }       → JSON body { success: false, fallbackMessage }
//   { ndjson: [...] }                → NDJSON stream (Content-Type: application/x-ndjson)
//   { status: 500 }                  → HTTP status only (default body '{}')
//   { throw: true }                  → destroys the socket; package sees a connection error
//   { body: {...} }                  → raw body verbatim
//
// All shorthands accept an optional `delayMs: N` to sleep before responding.

const express = require('express');

function createStore() {
  return {
    script: [],     // FIFO of normalized Response objects
    rules: [],      // [{ matcher: (req) => bool, response, once }]
    defaults: { kind: 'echo' }, // 'echo' | { kind: 'response', response }
    calls: [],      // [{ at, path, body }]
    readReceipts: []
  };
}

function normalizeResponse(input) {
  if (input == null) return { kind: 'json', status: 200, body: { success: true } };

  // Already-normalized?
  if (input.kind === 'json' || input.kind === 'ndjson' || input.kind === 'throw') {
    return { status: 200, ...input };
  }

  const delayMs = input.delayMs || 0;

  if (input.throw) {
    return { kind: 'throw', delayMs };
  }

  if (input.ndjson) {
    return { kind: 'ndjson', status: input.status || 200, lines: input.ndjson, delayMs };
  }

  // Shorthand mapping → JSON body.
  let body;
  if (input.body !== undefined) {
    body = input.body;
  } else if (input.messages) {
    body = { success: true, messages: input.messages, ...(input.silence && { silence: true }) };
  } else if (input.silence) {
    body = { success: true, silence: true };
  } else if (input.fallbackMessage) {
    body = { success: false, fallbackMessage: input.fallbackMessage };
  } else if (input.status && input.status >= 400) {
    body = input.body || '';
  } else {
    body = { success: true };
  }

  return {
    kind: 'json',
    status: input.status || 200,
    body,
    delayMs
  };
}

function pickResponse(store, req) {
  // Rules first (in order).
  for (let i = 0; i < store.rules.length; i++) {
    const rule = store.rules[i];
    let matched = false;
    try {
      matched = rule.matcher(req);
    } catch (_) {
      matched = false;
    }
    if (matched) {
      if (rule.once) store.rules.splice(i, 1);
      return rule.response;
    }
  }
  // Then script queue.
  if (store.script.length > 0) {
    return store.script.shift();
  }
  // Default.
  if (store.defaults.kind === 'response') return store.defaults.response;
  return null; // signal: use built-in echo
}

function buildEcho(req) {
  const text = `echo: ${req.body?.message || ''}`;
  return normalizeResponse({ messages: [text] });
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendJson(res, response) {
  res.status(response.status);
  if (typeof response.body === 'string') {
    res.type('text/plain').send(response.body);
  } else {
    res.json(response.body);
  }
}

function sendNdjson(res, response) {
  res.status(response.status);
  res.setHeader('Content-Type', 'application/x-ndjson');
  for (const line of response.lines) {
    res.write(JSON.stringify(line) + '\n');
  }
  res.end();
}

function createApp({ store } = {}) {
  const s = store || createStore();
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.post('/chat', async (req, res) => {
    s.calls.push({ at: new Date().toISOString(), path: '/chat', body: req.body });

    const picked = pickResponse(s, req) || buildEcho(req);
    const response = normalizeResponse(picked);

    await sleep(response.delayMs);

    if (response.kind === 'throw') {
      // Best-effort: forcibly close the socket so the package sees a network error.
      try { req.socket.destroy(); } catch (_) { /* ignore */ }
      return;
    }

    if (response.kind === 'ndjson') {
      return sendNdjson(res, response);
    }

    return sendJson(res, response);
  });

  app.post('/read-receipt', (req, res) => {
    s.readReceipts.push({ at: new Date().toISOString(), body: req.body });
    res.status(200).end();
  });

  // ------------- Admin control plane --------------------------------------

  app.get('/_admin/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/_admin/script', (req, res) => {
    const body = req.body || {};
    const items = Array.isArray(body.responses)
      ? body.responses
      : (body.response ? [body.response] : (Array.isArray(body) ? body : [body]));
    for (const item of items) {
      s.script.push(normalizeResponse(item));
    }
    res.json({ scripted: items.length, queueLength: s.script.length });
  });

  app.post('/_admin/rule', (req, res) => {
    const { matcher, response, once } = req.body || {};
    if (!matcher) return res.status(400).json({ error: 'matcher required' });

    let matchFn;
    if (matcher.regex) {
      const re = new RegExp(matcher.regex, matcher.flags || '');
      const path = matcher.path || 'body.message';
      matchFn = (req) => {
        const value = path.split('.').reduce((v, k) => v?.[k], req);
        return typeof value === 'string' && re.test(value);
      };
    } else if (matcher.equals !== undefined) {
      const path = matcher.path || 'body.message';
      const target = matcher.equals;
      matchFn = (req) => path.split('.').reduce((v, k) => v?.[k], req) === target;
    } else {
      return res.status(400).json({ error: 'matcher must specify { regex } or { equals }' });
    }

    s.rules.push({ matcher: matchFn, response: normalizeResponse(response), once: !!once });
    res.json({ rules: s.rules.length });
  });

  app.post('/_admin/default', (req, res) => {
    const { behavior, response } = req.body || {};
    if (behavior === 'echo') {
      s.defaults = { kind: 'echo' };
    } else if (behavior === 'response') {
      s.defaults = { kind: 'response', response: normalizeResponse(response) };
    } else {
      return res.status(400).json({ error: "behavior must be 'echo' or 'response'" });
    }
    res.json({ defaults: s.defaults });
  });

  app.get('/_admin/calls', (req, res) => {
    res.json({ calls: s.calls, readReceipts: s.readReceipts });
  });

  app.post('/_admin/reset', (req, res) => {
    s.script.length = 0;
    s.rules.length = 0;
    s.calls.length = 0;
    s.readReceipts.length = 0;
    s.defaults = { kind: 'echo' };
    res.json({ ok: true });
  });

  return { app, store: s };
}

module.exports = {
  createApp,
  createStore,
  normalizeResponse
};
