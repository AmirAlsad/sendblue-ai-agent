import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

const usersByPhone = new Map([
  [
    '+15551234567',
    {
      userId: 'user_alice',
      data: {
        name: 'Alice Example',
        plan: 'pro',
        locale: 'en-US',
        timezone: 'America/New_York',
        notes: ['prefers concise replies', 'eligible for iMessage-only features']
      }
    }
  ],
  [
    '+15557654321',
    {
      userId: 'user_bob',
      data: {
        name: 'Bob Example',
        plan: 'free',
        locale: 'en-US',
        timezone: 'America/Chicago',
        notes: ['may downgrade to SMS in weak coverage']
      }
    }
  ]
]);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'identity-lookup' });
});

app.post('/lookup', (req, res) => {
  const body = req.body || {};
  const phoneNumber = body.phoneNumber || body.value;

  if (body.resolveBy && body.resolveBy !== 'phone') {
    res.status(400).json({ error: 'only resolveBy=phone is supported by this example' });
    return;
  }

  if (typeof phoneNumber !== 'string' || phoneNumber.trim() === '') {
    res.status(400).json({ error: 'phoneNumber or value is required' });
    return;
  }

  const identity = usersByPhone.get(phoneNumber);

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'identity.lookup',
      phoneNumber,
      lineNumber: body.lineNumber,
      conversationKey: body.conversationKey,
      found: Boolean(identity)
    })
  );

  res.json(identity || null);
});

const port = Number.parseInt(process.env.PORT || '4002', 10);
app.listen(port, () => {
  console.log(`identity lookup endpoint listening on http://localhost:${port}`);
  console.log(`set USER_LOOKUP_URL=http://localhost:${port}/lookup`);
});

