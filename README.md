# whatsapp-mcp-bot

Answers WhatsApp requests addressed to you, from your own number. It runs on Cloudflare:
a Worker, one Durable Object per chat ([Agents SDK](https://developers.cloudflare.com/agents/)),
and a [Workflow](https://developers.cloudflare.com/agents/agent-class/run-workflows/) per reply.
WhatsApp itself comes from [kamikaz1k/whatsapp-mcp](https://github.com/kamikaz1k/whatsapp-mcp),
a fork of [whatsapp-mcp](https://github.com/felipeadeildo/whatsapp-mcp) that adds inline photo
sending, deployed separately and linked to your phone as a device.

```
WhatsApp ⇄ whatsapp-mcp (linked device, own Worker)
              │ signed webhook (message.received, message.sent)
              ▼
        this Worker: verify → trigger? → ChatAgent(chat).enqueue → 200
              │
              ▼
        ChatAgent (one per chat): stores the trigger, reacts 👀, runs one ReplyWorkflow at a time
              │
              ▼
        ReplyWorkflow: chat context → OpenAI background response (web search, images)
                       → poll → reply to the message, from your number, starting with 🤖
                                (generated images sent inline as photos)
                       failure → ❌ reaction instead
```

## When it answers

- Someone in a **subscribed** chat tags you and the text then starts with `bot`:
  `@Ana bot can you summarize the above?`
- In a **subscribed** direct chat, a message starts with `bot`.
- **You** send a message starting with `bot`, in any chat.

Replies start with 🤖 and never trigger it. `TRIGGER_WORD`, `REPLY_PREFIX`, `ACK_EMOJI` and
`FAIL_EMOJI` are vars in `wrangler.jsonc`.

Several requests in one chat while it's busy are answered together, in one reply, once the
current one finishes. Different chats run in parallel.

## Durability

- **Webhook → agent:** the Worker answers 200 only after the ChatAgent has stored the trigger,
  so whatsapp-mcp retries anything that didn't land. Triggers are stored once per message id,
  so repeated deliveries are dropped.
- **Reply:** each Workflow step's result is saved, so a redeploy resumes at the next step. The
  generation runs on OpenAI's side in background mode; only its id is kept, then polled.
- **Sends are idempotent:** each reply message is its own step with
  `idempotency_key: reply-<message id>-<n>`, so a retried step can't post twice; reactions
  are naturally idempotent.
- **Images:** generated images are kept in KV (step results are capped at 1 MiB) and sent as
  inline photos through the fork's `POST /messages` `image` field. A short answer is the first
  photo's caption; a long one goes first as text.
- **Lost callbacks:** every 5 minutes, `sweep` checks running batches against their Workflow
  status, and gives up (❌) on any older than 30 minutes.

## API

All but the webhook and images need `Authorization: Bearer $BOT_SECRET`.

| Route | What it does |
|---|---|
| `POST /wa/webhook` | Events from whatsapp-mcp (Standard Webhooks signature) |
| `GET /subscriptions` | `{ chats, allowedSenders }` |
| `PUT /subscriptions` | Replaces them. `chats`: JIDs or phone numbers where others may call the bot. `allowedSenders`: if not empty, only these may |
| `GET /chats?type=group` | Your chats, to find JIDs |

```bash
curl -s "$BOT_URL/chats?type=group" -H "Authorization: Bearer $BOT_SECRET" | jq '.chats[] | {jid, name}'
curl -s -X PUT "$BOT_URL/subscriptions" -H "Authorization: Bearer $BOT_SECRET" \
  -d '{"chats": ["120363000000000000@g.us", "15551234567"], "allowedSenders": []}'
```

## Setup

1. **whatsapp-mcp:** clone the fork and deploy it (Workers Paid, $5/month, keeps it connected all day),
   set its `SECRET`, open `https://whatsapp-mcp.<you>.workers.dev`, and link your phone.
2. **This Worker:** set `WA_API_URL` in `wrangler.jsonc`, then:
   ```bash
   npm install
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put WA_API_SECRET   # whatsapp-mcp's SECRET
   npx wrangler secret put BOT_SECRET      # openssl rand -hex 32
   npm run deploy
   ```
3. **Webhook:** create it on whatsapp-mcp and store its signing secret here:
   ```bash
   curl -s -X POST "$WA_API_URL/accounts/personal/webhooks" -H "Authorization: Bearer $WA_SECRET" \
     -d "{\"url\": \"$BOT_URL/wa/webhook\", \"events\": [\"message.received\", \"message.sent\"], \"description\": \"whatsapp-mcp-bot\"}"
   npx wrangler secret put WA_WEBHOOK_SECRET   # the "secret" from the answer
   ```
4. **Subscribe** to chats with `PUT /subscriptions`.

## Development

```bash
npm test          # trigger rules, signatures, OpenAI request/answer handling
npm run check     # types + tests
npm run types     # after changing wrangler.jsonc
```

Unofficial client: WhatsApp can ban accounts that use one. OpenAI stores background responses
for 30 days (`store: true` is required for background mode).
