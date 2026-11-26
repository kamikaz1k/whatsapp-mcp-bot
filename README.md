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
- Someone in a **subscribed** chat replies to one of your messages (the bot's included) and
  the text starts with `bot`. WhatsApp's own reply, not a typed quote.
- In a **subscribed** direct chat, a message starts with `bot`.
- **You** send a message starting with `bot`, in any chat.

**Subscribing:** send `bot subscribe` in a chat to let others there call the bot (✅), and
`bot unsubscribe` to stop them (🔕). Only your own messages can do this. The API works too.

**Chat instructions:** give a chat its own personality or rules for given situations with
`bot set prompt <text>` (✅), see them with `bot show prompt`, remove them with
`bot clear prompt` (🔕). You can also just ask: `bot from now on in this chat, end every
answer with a haiku`. The bot rewrites them with an owner-only tool and replies with the new
text. They go in the system prompt after the fixed rules, so they can't lift them (stats stay
yours, the bot never claims to be you), up to 2,000 characters, and reach OpenAI with every
request in that chat.

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
| `POST /subscriptions/chats/:chat` | Subscribes one chat (JID or phone number); `DELETE` unsubscribes it |
| `GET /chats?type=group` | Your chats, to find JIDs |
| `GET /chats/:chat/settings` | That chat's `instructions`; `PUT { "instructions": "…" }` sets them, `DELETE` clears them |
| `GET /usage?days=30&by=day` | Token totals, grouped `by` day, chat, use_case, model, status or chat_type |
| `GET /usage/recent?limit=50` | The latest replies' usage, one row per OpenAI response |

```bash
curl -s "$BOT_URL/chats?type=group" -H "Authorization: Bearer $BOT_SECRET" | jq '.chats[] | {jid, name}'
curl -s -X PUT "$BOT_URL/subscriptions" -H "Authorization: Bearer $BOT_SECRET" \
  -d '{"chats": ["120363000000000000@g.us", "15551234567"], "allowedSenders": []}'
```

## Usage tracking

Every OpenAI response is recorded in D1 (`DB`): input, cached, output and reasoning tokens,
web searches, images, seconds, chat and use case (`image`, `search` or `chat`). OpenAI's
dashboard can't group by request labels, only by project, API key and model, so for
per-chat numbers use `/usage`. To split the bot out on OpenAI's side, give it its own API key
or project; `OPENAI_PROJECT` sends `OpenAI-Project` for a key in several projects.

Each request is still labelled at OpenAI, for its logs: `metadata` (`app`, `use`,
`chat_type`, `chat`, `requests`, `workflow`), `X-Client-Request-Id: <workflow id>`,
`safety_identifier` (a sha256 of who asked) and `prompt_cache_key` (per chat, to share its
cache). No phone numbers or JIDs are sent in those labels.

Costs are estimates at list prices, set by the `PRICE_*` vars (gpt-6.1-terra's by default:
$1 / $0.05 cached / $1.25 cache write / $5 output per million tokens, plus about $0.01 per web
search and $0.04 per image). You can also ask the bot: `bot how much have you cost this week?`.
It has a `get_usage_stats` tool only when the request is yours, and outside your own
"message yourself" chat it only reports that chat.

```bash
curl -s "$BOT_URL/usage?by=chat&days=7" -H "Authorization: Bearer $BOT_SECRET" | jq
```

## Setup

1. **whatsapp-mcp:** clone the fork and deploy it (Workers Paid, $5/month, keeps it connected all day),
   set its `SECRET`, open `https://whatsapp-mcp.<you>.workers.dev`, and link your phone.
2. **This Worker:** it reaches whatsapp-mcp through a service binding to the Worker named
   `whatsapp-mcp` (change `services` in `wrangler.jsonc` if yours is named differently). Then:
   ```bash
   npm install
   npx wrangler secret put OWNER_NAME      # your first name, as the bot calls you
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

## What reaches OpenAI

The last 40 messages of the chat (12k characters at most) and any messages the request
replies to. For anything older the model calls `read_chat_history`, which reads further back
in **the same chat only**: a keyword search (whatsapp-mcp's `GET /chats/:chat/search`, up to
100 hits) or a page of up to 1,000 messages before a time, about 60k characters a call. It can
page back as far as whatsapp-mcp's archive goes, five tool rounds per reply. Anyone who may
call the bot in a chat can ask about that chat's history, including messages from before
they joined it. People without a WhatsApp name show as `person-xxxx`, `@<number>` mentions as
`@<name>`, and messages deleted for everyone are left out. No phone numbers or JIDs go in
the request labels.

Unofficial client: WhatsApp can ban accounts that use one. OpenAI stores background responses
for 30 days (`store: true` is required for background mode).

## License

[MIT](LICENSE)
