import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

function getIncomingText(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages
      .map((message, index) => {
        const content = typeof message.content === 'string' ? message.content : '';
        return `${index + 1}. ${content}`;
      })
      .join('\n');
  }

  return typeof body.message === 'string' ? body.message : '';
}

function summarizeContext(body) {
  const conversation = body.conversation || {};
  const identity = body.identity || null;
  const typing = body.typing || null;
  const sendblue = body.sendblue || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const channels = [...new Set(messages.map(message => message.channel).filter(Boolean))];
  const hasMedia = messages.some(message => Boolean(message.mediaUrl));
  const smsDowngraded = Boolean(conversation.smsDowngraded || sendblue.wasDowngraded);

  return {
    messageCount: messages.length || (body.message ? 1 : 0),
    channel: conversation.channel || body.channel || 'unknown',
    channels,
    smsDowngraded,
    hasMedia,
    identityLabel: identity?.data?.name || identity?.userId || 'unknown user',
    userId: identity?.userId || null,
    typingSeen: Boolean(typing?.isTyping),
    conversationKey: conversation.key || null
  };
}

function buildContextualReply(body) {
  const text = getIncomingText(body);
  const context = summarizeContext(body);
  const caution = context.smsDowngraded
    ? ' I will avoid iMessage-only features because this conversation is currently SMS/downgraded.'
    : '';
  const typing = context.typingSeen
    ? ' I also saw a recent typing signal before this message arrived.'
    : '';
  const media = context.hasMedia
    ? ' I noticed at least one message included media metadata.'
    : '';

  return [
    `Hi ${context.identityLabel}. I received ${context.messageCount} message${context.messageCount === 1 ? '' : 's'} on ${context.channel}.`,
    `Latest buffered text:\n${text}`,
    `${caution}${typing}${media}`.trim()
  ]
    .filter(Boolean)
    .join('\n\n');
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'v02-rich-chat-endpoint' });
});

app.post('/chat', (req, res) => {
  const body = req.body || {};
  const text = typeof body.message === 'string' ? body.message.toLowerCase() : '';
  const context = summarizeContext(body);

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'chat.v02_request',
      ...context
    })
  );

  if (text.includes('silence')) {
    res.json({ silence: true });
    return;
  }

  if (text.includes('multi')) {
    res.json({
      messages: [
        `I received your ${context.messageCount}-message burst.`,
        context.smsDowngraded
          ? 'Because this route is downgraded to SMS, I am keeping the replies plain text.'
          : 'The ordered-delivery queue will send these replies one at a time.'
      ]
    });
    return;
  }

  if (text.includes('human')) {
    res.json({
      message: `I found ${context.identityLabel} and would route this to a human handoff workflow in a real app.`
    });
    return;
  }

  res.json({ message: buildContextualReply(body) });
});

const port = Number.parseInt(process.env.PORT || '4003', 10);
app.listen(port, () => {
  console.log(`v0.2 rich chat endpoint listening on http://localhost:${port}`);
  console.log(`set CHAT_ENDPOINT_URL=http://localhost:${port}/chat`);
});

