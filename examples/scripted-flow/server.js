import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

const HOSTED_MENU_URL =
  process.env.HOSTED_MENU_URL || 'https://upload.wikimedia.org/wikipedia/commons/a/a3/Eq_it-na_pizza-margherita_sep2005_sml.jpg';

// In-memory state keyed by conversation.key. Resets on restart.
// One record across iMessage/RCS/SMS — the transport already collapses
// channel switches into the same key for us.
const sessions = new Map();

function getSession(body) {
  const key = body.conversation?.key || `fallback:${body.fromNumber || 'unknown'}`;
  let session = sessions.get(key);
  if (!session) {
    session = { step: 'new', recentHandles: [] };
    sessions.set(key, session);
  }
  return { key, session };
}

function incomingText(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n').trim();
  }
  return typeof body.message === 'string' ? body.message : '';
}

function lastInboundHandle(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.at(-1)?.messageHandle || body.messageHandle || null;
}

function isSmsLike(body) {
  return Boolean(
    body.conversation?.smsDowngraded ||
      body.sendblue?.wasDowngraded ||
      body.conversation?.channel === 'sms' ||
      body.channel === 'sms' ||
      body.sendblue?.service === 'SMS'
  );
}

function buildResponse(body, session) {
  const text = incomingText(body);
  const lower = text.toLowerCase();
  const handle = lastInboundHandle(body);
  const smsLike = isSmsLike(body);

  // Dedupe: same exact inbound message handle in a row → silence.
  // The transport also dedupes at the webhook layer; this guards against
  // user-side duplicates inside one buffer flush.
  if (handle && session.recentHandles.includes(handle)) {
    return { silence: true };
  }
  if (handle) {
    session.recentHandles = [...session.recentHandles.slice(-4), handle];
  }

  if (session.step === 'new') {
    session.step = 'sizing';
    const greeting = {
      type: 'message',
      content: "Welcome to Pizza HQ — your pickup order starts here. What size pizza? (small, medium, large)"
    };
    if (!smsLike) greeting.sendStyle = 'celebration';
    return { actions: [greeting] };
  }

  if (session.step === 'sizing') {
    session.size = text;
    session.step = 'toppings';
    const actions = [];
    // Acknowledge with a Tapback on iMessage; SMS gets a plain ack message.
    if (!smsLike && handle) {
      actions.push({ type: 'reaction', reaction: 'like', target: { messageHandle: handle } });
    }
    actions.push({
      type: 'message',
      content: `Got it — ${session.size}. What toppings? (e.g. pepperoni, mushroom, plain cheese)`
    });
    return { actions };
  }

  if (session.step === 'toppings') {
    session.toppings = text;
    session.step = 'naming';
    const target = handle ? { messageHandle: handle } : { alias: 'latest' };
    return {
      actions: [
        {
          type: 'reply',
          target,
          content: `Confirming: ${session.size} with ${session.toppings}. Here is today's menu in case you want to add anything.`
        },
        {
          type: 'media',
          mediaUrl: HOSTED_MENU_URL,
          content: 'Menu — message any additions or just send your name to confirm.'
        },
        { type: 'message', content: 'What name should the order be under?' }
      ]
    };
  }

  if (session.step === 'naming') {
    session.name = text;
    session.step = 'waiting';
    const message = {
      type: 'message',
      content: `Thanks ${session.name}! Your ${session.size} ${session.toppings} pizza is in the oven. Text "here" when you arrive for pickup.`
    };
    if (!smsLike) message.sendStyle = 'fireworks';
    return { actions: [message] };
  }

  if (session.step === 'waiting') {
    const arrived = /\b(here|arrived|outside|i'?m here|im here)\b/.test(lower);
    if (arrived) {
      session.step = 'done';
      const actions = [];
      if (!smsLike && handle) {
        actions.push({ type: 'reaction', reaction: 'love', target: { messageHandle: handle } });
      }
      actions.push({
        type: 'message',
        content: `Bringing your pizza out now, ${session.name}. Thanks for ordering!`
      });
      return { actions };
    }
    return {
      actions: [
        {
          type: 'message',
          content: 'Your order is still in the oven — we will be ready in a few minutes. Text "here" when you arrive.'
        }
      ]
    };
  }

  // step === 'done': polite wrap-up; subsequent messages start a new order.
  session.step = 'new';
  return {
    actions: [
      { type: 'message', content: 'Want to start another order? Reply with the size and we will go again.' }
    ]
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'scripted-flow', sessions: sessions.size });
});

app.post('/chat', (req, res) => {
  const body = req.body || {};
  const { key, session } = getSession(body);
  const previousStep = session.step;
  const response = buildResponse(body, session);

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'chat.scripted_flow',
      conversationKey: key,
      previousStep,
      nextStep: session.step,
      messageHandle: body.messageHandle || null,
      actionTypes: (response.actions || []).map(a => a.type)
    })
  );

  res.json(response);
});

const port = Number.parseInt(process.env.PORT || '4005', 10);
app.listen(port, () => {
  console.log(`scripted-flow endpoint listening on http://localhost:${port}`);
  console.log(`set CHAT_ENDPOINT_URL=http://localhost:${port}/chat`);
});
