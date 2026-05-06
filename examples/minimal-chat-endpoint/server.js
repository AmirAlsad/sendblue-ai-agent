import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'minimal-chat-endpoint' });
});

app.post('/chat', (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : '';
  const fromNumber = req.body?.fromNumber || req.body?.conversation?.phoneNumber || 'unknown';

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'chat.request',
      fromNumber,
      message
    })
  );

  if (message.trim().toLowerCase() === 'silence') {
    res.json({ silence: true });
    return;
  }

  res.json({ message: `Echo: ${message}` });
});

const port = Number.parseInt(process.env.PORT || '4001', 10);
app.listen(port, () => {
  console.log(`minimal chat endpoint listening on http://localhost:${port}`);
  console.log(`set CHAT_ENDPOINT_URL=http://localhost:${port}/chat`);
});

