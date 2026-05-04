// Minimal user-lookup webhook for verifying twilio-ai-agent end-to-end.
// Listens on PORT (default 4000). Implements the contract documented in
// examples/chat-endpoint-pseudocode.md (user-lookup section).
//
//   node examples/mock-services/user-lookup.js
//
// Then point USER_LOOKUP_URL=http://localhost:4000/lookup in your .env.

const express = require('express');

const app = express();
app.use(express.json());

const USERS = {
  byPhone: {
    '+15551111111': { userId: 'user-1', channel: 'sms',      data: { tier: 'paid', name: 'Alice' } },
    '+15552222222': { userId: 'user-2', channel: 'whatsapp', data: { tier: 'free', name: 'Bob'   } }
  },
  byUserId: {
    'user-1': { phone: '+15551111111', channel: 'sms',      data: { tier: 'paid', name: 'Alice' } },
    'user-2': { phone: '+15552222222', channel: 'whatsapp', data: { tier: 'free', name: 'Bob'   } }
  }
};

app.post('/lookup', (req, res) => {
  const { resolveBy, value, limit = 1000 } = req.body || {};

  if (resolveBy === 'phone') {
    const hit = USERS.byPhone[value];
    if (!hit) return res.json(null);
    return res.json({ userId: hit.userId, phone: value, channel: hit.channel, data: hit.data });
  }

  if (resolveBy === 'userId') {
    const hit = USERS.byUserId[value];
    if (!hit) return res.json(null);
    return res.json({ userId: value, phone: hit.phone, channel: hit.channel, data: hit.data });
  }

  if (resolveBy === 'listActive') {
    const all = Object.keys(USERS.byUserId);
    return res.json({ users: all.slice(0, limit), nextCursor: null });
  }

  res.status(400).json({ error: 'unknown resolveBy: ' + resolveBy });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`mock user-lookup listening on http://localhost:${PORT}`);
});
