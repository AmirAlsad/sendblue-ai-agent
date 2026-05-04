// Minimal echo chat endpoint for verifying twilio-ai-agent end-to-end.
// Listens on PORT (default 4001). Implements the contract documented in
// examples/chat-endpoint-pseudocode.md.
//
//   node examples/mock-services/chat-endpoint.js
//
// Then point CHAT_ENDPOINT_URL=http://localhost:4001/chat in your .env.

const express = require('express');

const app = express();
app.use(express.json());

app.post('/chat', async (req, res) => {
  const { message, stream } = req.body || {};
  const reply = `echo: ${message || ''}`;

  if (stream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write(JSON.stringify({ type: 'message', index: 0, text: reply }) + '\n');
    res.write(JSON.stringify({ type: 'done', success: true, silence: false }) + '\n');
    res.end();
    return;
  }

  res.json({ success: true, messages: [reply] });
});

app.post('/read-receipt', (req, res) => {
  // eslint-disable-next-line no-console
  console.log('read receipt:', req.body);
  res.status(200).end();
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`mock chat-endpoint listening on http://localhost:${PORT}`);
});
