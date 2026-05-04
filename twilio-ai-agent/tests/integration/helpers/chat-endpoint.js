// In-process JS API wrapper around examples/test-chat-endpoint/app.js.
//
// Tests import this and drive the chat endpoint via direct method calls
// instead of HTTP. The Express app is the same code as the standalone
// server, so behaviour is identical — this just removes the HTTP control
// plane for ergonomic test code.
//
// Usage:
//
//   const { createTestEndpoint } = require('../helpers/chat-endpoint');
//
//   const endpoint = createTestEndpoint();
//   await endpoint.listen(4001);
//
//   endpoint.scriptNext({ silence: true });
//   endpoint.setRule(req => req.body.userId === 'u_paid', { messages: ['hi'] });
//   // ... fire a webhook / call /chat directly ...
//   console.log(endpoint.calls);
//
//   await endpoint.close();

const { createApp, createStore, normalizeResponse } = require('../../../examples/test-chat-endpoint/app');

function createTestEndpoint() {
  const store = createStore();
  const { app } = createApp({ store });
  let server = null;

  function listen(port = 0) {
    return new Promise((resolve, reject) => {
      server = app.listen(port, () => {
        const actualPort = server.address().port;
        resolve({ port: actualPort, url: `http://localhost:${actualPort}` });
      });
      server.on('error', reject);
    });
  }

  function close() {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      // Forcibly close any keepalive connections so the close() promise
      // resolves promptly under test conditions.
      try { server.closeAllConnections?.(); } catch (_) { /* ignore */ }
      server.close(() => {
        server = null;
        resolve();
      });
    });
  }

  function scriptNext(response) {
    store.script.push(normalizeResponse(response));
  }

  function scriptMany(responses) {
    for (const r of responses) store.script.push(normalizeResponse(r));
  }

  function setRule(matcher, response, opts = {}) {
    let matchFn;
    if (typeof matcher === 'function') {
      matchFn = matcher;
    } else if (matcher instanceof RegExp) {
      matchFn = (req) => typeof req.body?.message === 'string' && matcher.test(req.body.message);
    } else if (typeof matcher === 'string') {
      matchFn = (req) => req.body?.message === matcher;
    } else {
      throw new Error('matcher must be a function, RegExp, or string');
    }
    store.rules.push({ matcher: matchFn, response: normalizeResponse(response), once: !!opts.once });
  }

  function setDefault(response) {
    if (response === 'echo' || response == null) {
      store.defaults = { kind: 'echo' };
    } else {
      store.defaults = { kind: 'response', response: normalizeResponse(response) };
    }
  }

  function reset() {
    store.script.length = 0;
    store.rules.length = 0;
    store.calls.length = 0;
    store.readReceipts.length = 0;
    store.defaults = { kind: 'echo' };
  }

  return {
    listen,
    close,
    scriptNext,
    scriptMany,
    setRule,
    setDefault,
    reset,
    get calls() { return store.calls; },
    get readReceipts() { return store.readReceipts; },
    get url() { return server ? `http://localhost:${server.address().port}` : null; },
    get port() { return server ? server.address().port : null; },
    _store: store,
    _app: app
  };
}

module.exports = { createTestEndpoint };
