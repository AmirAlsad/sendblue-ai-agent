import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

function incomingText(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages
      .map(message => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
      .trim();
  }

  return typeof body.message === 'string' ? body.message : '';
}

function lowerText(body) {
  return incomingText(body).toLowerCase();
}

function lastInboundHandle(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const latest = messages.at(-1);
  return latest?.messageHandle || body.messageHandle || null;
}

function lastInboundTarget(body) {
  const messageHandle = lastInboundHandle(body);
  return messageHandle ? { messageHandle } : { alias: 'latest' };
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

function isAddressedGroup(body, text) {
  const alias = (process.env.AGENT_DISPLAY_NAME || 'sb-agent').trim().toLowerCase();
  const hasGroupId = Boolean(body.sendblue?.groupId || body.conversation?.groupId);

  return hasGroupId && alias !== '' && text.includes(alias);
}

function hostedMediaUrl(path) {
  const base = (process.env.HOSTED_MEDIA_BASE_URL || 'https://cdn.example.com/sendblue').replace(
    /\/+$/,
    ''
  );
  return `${base}/${path.replace(/^\/+/, '')}`;
}

function actionsResponse(body) {
  const text = lowerText(body);
  const target = lastInboundTarget(body);
  const smsLike = isSmsLike(body);

  if (text.includes('silence')) {
    return { actions: [{ type: 'silence', reason: 'user requested silence' }] };
  }

  if (text.includes('group')) {
    if (!isAddressedGroup(body, text)) {
      return { actions: [{ type: 'silence', reason: 'group message was not addressed' }] };
    }

    return {
      actions: [
        {
          type: 'message',
          content: 'Addressed group reply. I will answer because the group message mentioned the agent name.'
        }
      ]
    };
  }

  if (text.includes('reaction')) {
    return smsLike
      ? { actions: [{ type: 'message', content: 'I would react here, but this conversation is SMS/downgraded.' }] }
      : { actions: [{ type: 'reaction', reaction: 'love', target }] };
  }

  if (text.includes('reply')) {
    return {
      actions: [
        {
          type: 'reply',
          content: 'This rich action is meant to thread against your last inbound message.',
          target
        }
      ]
    };
  }

  if (text.includes('media')) {
    return {
      actions: [
        {
          type: 'message',
          content: 'Hosted media caption from the example endpoint.',
          mediaUrl: hostedMediaUrl('demo-image.png')
        }
      ]
    };
  }

  if (text.includes('effect')) {
    return smsLike
      ? { actions: [{ type: 'message', content: 'Effects are iMessage-only, so this is a plain fallback.' }] }
      : {
          actions: [
            {
              type: 'message',
              content: 'This message asks Sendblue for a celebration effect.',
              sendStyle: 'celebration'
            }
          ]
        };
  }

  if (text.includes('receipt')) {
    return {
      actions: [
        { type: 'message', content: 'Read receipts are controlled by READ_RECEIPTS_ENABLED in the agent.' }
      ]
    };
  }

  if (text.includes('typing')) {
    return smsLike
      ? { actions: [{ type: 'message', content: 'Typing refreshes are suppressed for SMS/downgraded chats.' }] }
      : {
          actions: [
            { type: 'message', content: 'The agent refreshes typing while this response is being processed.' }
          ]
        };
  }

  if (text.includes('multi')) {
    return {
      actions: [
        { type: 'message', content: 'First action message.' },
        { type: 'message', content: 'Second action message, still ordered by the agent queue.' }
      ]
    };
  }

  return {
    actions: [
      {
        type: 'message',
        content: 'Rich actions endpoint ready. Try multi, silence, reaction, reply, media, effect, receipt, typing, or an addressed group prompt.'
      }
    ]
  };
}

function xmlTaggedResponse(body) {
  const text = lowerText(body);
  const target = lastInboundHandle(body);

  if (text.includes('silence')) {
    return { message: '<no_response />' };
  }

  if (text.includes('multi')) {
    return {
      message: [
        '<message>First XML-tagged reply.</message>',
        '<message>Second XML-tagged reply.</message>'
      ].join('\n')
    };
  }

  return {
    message: [
      '<message send_style="balloons">XML compatibility reply with an effect.</message>',
      `<message media_url="${hostedMediaUrl('demo-image.png')}">Hosted media through an XML tag.</message>`,
      target
        ? `<reaction type="love" target_message_handle="${target}" />`
        : '<reaction type="love" target="latest" />',
      target
        ? `<reply target_message_handle="${target}"><message>XML-tagged contextual reply.</message></reply>`
        : '<reply target="latest"><message>XML-tagged contextual reply.</message></reply>'
    ].join('\n')
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'rich-actions-chat-endpoint' });
});

app.post('/chat', (req, res) => {
  const body = req.body || {};
  const mode = String(req.query.mode || '').toLowerCase();
  const response = mode === 'xml' ? xmlTaggedResponse(body) : actionsResponse(body);

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'chat.rich_actions_request',
      mode: mode || 'actions',
      messageHandle: body.messageHandle || null,
      conversationKey: body.conversation?.key || null,
      actionCount: Array.isArray(response.actions) ? response.actions.length : undefined
    })
  );

  res.json(response);
});

const port = Number.parseInt(process.env.PORT || '4004', 10);
app.listen(port, () => {
  console.log(`rich actions chat endpoint listening on http://localhost:${port}`);
  console.log(`set CHAT_ENDPOINT_URL=http://localhost:${port}/chat`);
  console.log(`use CHAT_ENDPOINT_URL=http://localhost:${port}/chat?mode=xml for XML tag compatibility`);
});
