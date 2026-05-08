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

const HELP_TEXTS = {
  silence:
    'Returns `{ silence: true }`. Agent acks your message but sends nothing back. Success looks like no reply at all.',
  multi:
    'Two ordered `message` actions. The agent sends the second only after the first is DELIVERED. You should see a brief typing bubble between them.',
  react:
    'A `reaction` action — drops a heart Tapback on your "react" message. iMessage-only; on SMS the transport falls back to a plain text message instead.',
  reply:
    'A `reply` action targeting your last message. Sendblue\'s direct-send API has no native reply target yet, so it lands as a normal message — the resolved target is logged.',
  media:
    'A `media` action with a publicly hosted HTTPS URL. Sendblue fetches the URL at send time. Set `HOSTED_MEDIA_URL` to point at your own asset.',
  effect:
    'A `message` action with `sendStyle: "celebration"` — confetti rains down when it lands. iMessage-only; on SMS the transport falls back to plain text.',
  typing:
    'The chat endpoint stalls 1.5s before responding so the agent\'s typing-start delay (default 500ms) elapses. You should see a typing bubble for ~1s before the reply lands.',
  group:
    'Only fires in a group iMessage thread where the agent is addressed by name (default `sb-agent`). In a 1:1 chat like this one, you\'ll see no reply — that\'s correct. To exercise it, add the Sendblue line to a group with another participant and address it: "sb-agent group ping".',
  downgrade:
    'Replies with text describing whether the current conversation is iMessage or SMS-downgraded. Use it to confirm the transport is classifying the channel correctly.'
};

async function actionsResponse(body) {
  const text = incomingText(body).toLowerCase();
  const target = targetLastInbound(body);
  const smsLike = isSmsLike(body);

  if (text.startsWith('help')) {
    const arg = text.slice(4).trim();
    if (!arg) {
      return {
        actions: [
          {
            type: 'message',
            content:
              'Send `help <keyword>` for details. Keywords: silence, multi, react, reply, media, effect, typing, group, downgrade.'
          }
        ]
      };
    }
    for (const [keyword, explanation] of Object.entries(HELP_TEXTS)) {
      if (arg.includes(keyword)) {
        return { actions: [{ type: 'message', content: `${keyword}: ${explanation}` }] };
      }
    }
    return {
      actions: [
        {
          type: 'message',
          content: `Unknown keyword. Try: ${Object.keys(HELP_TEXTS).join(', ')}.`
        }
      ]
    };
  }

  if (text.includes('typing')) {
    // Stall past TYPING_START_DELAY_MS so the agent fires its typing
    // indicator. Default delay is 500ms; 1500ms gives the bubble ~1s of
    // visible time before this response lands and clears it.
    await new Promise(resolve => setTimeout(resolve, 1500));
    return {
      actions: [
        {
          type: 'message',
          content:
            'You should have seen a typing bubble for ~1s — the agent fires typing once your chat call exceeds TYPING_START_DELAY_MS (default 500ms) and stops as soon as your response arrives.'
        }
      ]
    };
  }

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
          'Action catalog ready. Try: silence, multi, react, reply, media, effect, typing, group, downgrade. Send `help <keyword>` for details on what each one does.'
      }
    ]
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'action-catalog' });
});

app.post('/chat', async (req, res) => {
  const body = req.body || {};
  const response = await actionsResponse(body);

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'chat.action_catalog',
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
});
