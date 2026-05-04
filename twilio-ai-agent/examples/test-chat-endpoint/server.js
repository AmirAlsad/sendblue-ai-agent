// Standalone runnable wrapper for the programmable test chat endpoint.
//
// Use as a chat endpoint stand-in for integration tests, manual smoke tests,
// or local development of any service that targets the twilio-ai-agent chat
// contract.
//
//   node examples/test-chat-endpoint/server.js
//   PORT=4001 node examples/test-chat-endpoint/server.js
//
// Then point CHAT_ENDPOINT_URL=http://localhost:4001/chat in .env.
// See README.md in this folder for the admin HTTP API.

const { createApp } = require('./app');

const PORT = process.env.PORT || 4001;
const { app, store } = createApp();

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`test-chat-endpoint listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log('  Configure responses via POST /_admin/script, /_admin/rule, /_admin/default');
  // eslint-disable-next-line no-console
  console.log('  Inspect via GET /_admin/calls; clear via POST /_admin/reset');
});

module.exports = { store };
