# scripted-flow

A small but realistic conversational arc — pizza order pickup — that walks
through every important action type *naturally* as the conversation
progresses, without any LLM. State lives in memory, keyed by
`conversation.key` (the same key the transport uses), so iMessage/SMS/RCS
switches stay on one record.

## Run

```bash
node examples/scripted-flow/server.js
# then
CHAT_ENDPOINT_URL=http://localhost:4005/chat
```

State resets on restart. There is no Redis, no LLM, and no external services
— just an in-memory `Map` and a `switch` over the current step.

## The conversation

| Step       | User says            | Bot returns                                                                              |
| ---------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `new`      | _anything_           | `message` + `sendStyle: celebration` greeting, asks for size                             |
| `sizing`   | "large"              | `reaction: like` Tapback (iMessage) + `message` asking for toppings                     |
| `toppings` | "pepperoni"          | `reply` confirming toppings + `media` action with menu image + follow-up message        |
| `naming`   | "Amir"               | `message` + `sendStyle: fireworks` confirmation                                          |
| `waiting`  | _anything but "here"_ | Patient `message` reminding the user to text "here" on arrival                          |
| `waiting`  | "here"               | `reaction: love` Tapback + `message` letting them know the pizza is coming out          |
| `done`     | _anything_           | Resets to `new` so the next message starts a fresh order                                 |

Throughout: a duplicate `messageHandle` inside the recent-handle window
returns `{ silence: true }` — useful to verify the silence path works.

## Channel awareness

Reactions and send styles drop automatically when the conversation is on
SMS/RCS or has been downgraded. Open `server.js` and search for `smsLike` to
see exactly where the fallbacks live.

## Configuration

| Env var          | Default                  | Notes                                |
| ---------------- | ------------------------ | ------------------------------------ |
| `PORT`           | `4005`                   |                                      |
| `HOSTED_MENU_URL`| a public pizza photo     | Set to your own HTTPS image URL      |

## Curl recipe (full flow)

```bash
KEY="direct:+15550000001:+15550000002"
HEADERS=(-H 'content-type: application/json')

# 1. greeting
curl -s http://localhost:4005/chat "${HEADERS[@]}" -d '{
  "message":"hi","messageHandle":"m1","channel":"imessage",
  "conversation":{"key":"'"$KEY"'","type":"direct","channel":"imessage","smsDowngraded":false},
  "sendblue":{"wasDowngraded":false,"raw":{}}
}' | jq

# 2. size
curl -s http://localhost:4005/chat "${HEADERS[@]}" -d '{
  "message":"large","messageHandle":"m2","channel":"imessage",
  "conversation":{"key":"'"$KEY"'","type":"direct","channel":"imessage","smsDowngraded":false},
  "sendblue":{"wasDowngraded":false,"raw":{}}
}' | jq
```
