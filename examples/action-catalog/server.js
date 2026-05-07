import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

const AGENT_NAME = (process.env.AGENT_DISPLAY_NAME || 'sb-agent').trim().toLowerCase();
const HOSTED_MEDIA_URL =
  process.env.HOSTED_MEDIA_URL || 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png';

function incomingText(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages
      .map(message => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
      .trim();
  }
  return typeof body.message === 'string' ? body.message : '';
}

function targetLastInbound(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const handle = messages.at(-1)?.messageHandle || body.messageHandle;
  return handle ? { messageHandle: handle } : { alias: 'latest' };
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

function isAddressedGroup(body, lowerText) {
  const inGroup = body.conversation?.type === 'group' || Boolean(body.conversation?.groupId);
  if (!inGroup) return false;
  if (body.conversation?.invocation?.reason === 'name') return true;
  return AGENT_NAME !== '' && lowerText.includes(AGENT_NAME);
}

function actionsResponse(body) {
  const text = incomingText(body).toLowerCase();
  const target = targetLastInbound(body);
  const smsLike = isSmsLike(body);

  if (text.includes('silence')) {
    return { silence: true };
  }

  if (text.includes('multi')) {
    return {
      actions: [
        { type: 'message', content: 'First reply — ordered delivery advances on per-channel status.' },
        { type: 'message', content: 'Second reply — sent only after the first one is confirmed.' }
      ]
    };
  }

  if (text.includes('react')) {
    if (smsLike) {
      return {
        actions: [
          { type: 'message', content: 'Tapback reactions are iMessage-only; this conversation is SMS/downgraded.' }
        ]
      };
    }
    return { actions: [{ type: 'reaction', reaction: 'love', target }] };
  }

  if (text.includes('reply')) {
    return {
      actions: [
        {
          type: 'reply',
          target,
          content: 'Reply intent targets your last inbound message. Sendblue direct sends deliver this as a normal message fallback today.'
        }
      ]
    };
  }

  if (text.includes('media')) {
    return {
      actions: [
        {
          type: 'media',
          mediaUrl: HOSTED_MEDIA_URL,
          content: 'Sendblue fetches this hosted URL at send time.'
        }
      ]
    };
  }

  if (text.includes('effect')) {
    if (smsLike) {
      return {
        actions: [
          { type: 'message', content: 'Send effects are iMessage-only; this conversation is SMS/downgraded.' }
        ]
      };
    }
    return {
      actions: [
        { type: 'message', content: 'Asking Sendblue for a celebration effect.', sendStyle: 'celebration' }
      ]
    };
  }

  if (text.includes('group')) {
    if (!isAddressedGroup(body, text)) {
      return { silence: true };
    }
    return {
      actions: [
        { type: 'message', content: `Addressed group reply — agent name "${AGENT_NAME}" was mentioned.` }
      ]
    };
  }

  if (text.includes('downgrade')) {
    return {
      actions: [
        {
          type: 'message',
          content: smsLike
            ? 'You are on SMS/downgraded. iMessage-only features (reactions, send effects, typing) are suppressed automatically.'
            : 'You are on iMessage. Try sending the same prompt over SMS to see the transport degrade rich actions.'
        }
      ]
    };
  }

  return {
    actions: [
      {
        type: 'message',
        content:
          'Action catalog ready. Try: silence, multi, react, reply, media, effect, group, downgrade. Append ?mode=xml to the URL to see XML-tagged output.'
      }
    ]
  };
}

function xmlResponse(body) {
  const text = incomingText(body).toLowerCase();
  const targetHandle =
    body.messages?.at(-1)?.messageHandle || body.messageHandle || null;
  const targetAttr = targetHandle
    ? ` target_message_handle="${targetHandle}"`
    : ' target="latest"';

  if (text.includes('silence')) return { message: '<no_response />' };

  if (text.includes('multi')) {
    return {
      message: ['<message>First XML-tagged reply.</message>', '<message>Second XML-tagged reply.</message>'].join('\n')
    };
  }

  if (text.includes('react')) {
    return { message: `<reaction type="love"${targetAttr} />` };
  }

  if (text.includes('reply')) {
    return {
      message: `<reply${targetAttr}><message>XML reply intent — delivered as a normal message fallback.</message></reply>`
    };
  }

  if (text.includes('media')) {
    return {
      message: `<message media_url="${HOSTED_MEDIA_URL}">Hosted media via XML tag.</message>`
    };
  }

  if (text.includes('effect')) {
    return { message: '<message send_style="celebration">XML message with a send effect.</message>' };
  }

  return {
    message:
      'XML mode ready. Try: silence, multi, react, reply, media, effect. The transport parses these tags into chat actions.'
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'action-catalog' });
});

app.post('/chat', (req, res) => {
  const body = req.body || {};
  const mode = String(req.query.mode || '').toLowerCase();
  const response = mode === 'xml' ? xmlResponse(body) : actionsResponse(body);

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'chat.action_catalog',
      mode: mode || 'actions',
      conversationKey: body.conversation?.key || null,
      messageHandle: body.messageHandle || null,
      actionCount: Array.isArray(response.actions) ? response.actions.length : undefined
    })
  );

  res.json(response);
});

const port = Number.parseInt(process.env.PORT || '4003', 10);
app.listen(port, () => {
  console.log(`action-catalog endpoint listening on http://localhost:${port}`);
  console.log(`set CHAT_ENDPOINT_URL=http://localhost:${port}/chat`);
  console.log(`for XML tag mode: CHAT_ENDPOINT_URL=http://localhost:${port}/chat?mode=xml`);
});
