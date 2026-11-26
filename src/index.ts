// whatsapp-mcp-bot: answers WhatsApp requests addressed to you ("@you bot …").
//
//   POST /wa/webhook        signed events from whatsapp-mcp → ChatAgent per chat
//   GET  /subscriptions     which chats others may call the bot from (Bearer BOT_SECRET)
//   PUT  /subscriptions     replace them: { chats: [...], allowedSenders: [...] }
//   POST /subscriptions/chats/:chat    add one chat; DELETE removes it
// In WhatsApp, you can also send "bot subscribe" or "bot unsubscribe" in a chat.
//   GET  /chats/:chat/settings   that chat's instructions; PUT { instructions } sets, DELETE clears
// In WhatsApp: "bot set prompt <text>", "bot show prompt", "bot clear prompt".
//   GET  /chats             your chats from whatsapp-mcp, to find JIDs (?type=group|direct)
//   GET  /usage             token totals: ?days=30&by=day|chat|use_case|model|status|chat_type
//   GET  /usage/recent      the latest replies' usage, ?limit=50
import { getAgentByName } from "agents"

import type { Env } from "./env"
import { getChatInstructions, MAX_CHAT_INSTRUCTIONS, setChatInstructions } from "./chat-settings"
import { changeSubscription, loadSubscriptions, saveSubscriptions } from "./subscriptions"
import { detectCommand, detectPromptCommand, detectTrigger, type ChatRef, type Subscriptions, type WaMessage } from "./trigger"
import { isGroup, prices, recentUsage, usageReport } from "./usage"
import { wa } from "./wa"
import { verifyWebhook } from "./webhook"

export { ChatAgent } from "./agent"
export { ReplyWorkflow } from "./workflow"


function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status })
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? ""
  const expected = `Bearer ${env.BOT_SECRET}`
  if (!env.BOT_SECRET || header.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

function parseSubscriptions(body: unknown): Subscriptions | null {
  if (typeof body !== "object" || body === null) return null
  const { chats, allowedSenders } = body as Record<string, unknown>
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && item.length < 200)
  if (!strings(chats) || (allowedSenders !== undefined && !strings(allowedSenders))) return null
  return {
    chats: chats as string[],
    allowedSenders: (allowedSenders as string[] | undefined) ?? [],
  }
}

async function webhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text()
  const verified = await verifyWebhook(env.WA_WEBHOOK_SECRET, request.headers, body)
  if (!verified.ok) return json(401, { error: verified.reason })

  const event = JSON.parse(body) as { type: string; data: { chat?: ChatRef; message?: WaMessage } }
  if (event.type !== "message.received" && event.type !== "message.sent") return json(200, { ignored: event.type })
  const { chat, message } = event.data
  if (!chat || !message) return json(200, { ignored: "no message" })

  const options = { word: env.TRIGGER_WORD, replyPrefix: env.REPLY_PREFIX }
  const promptCommand = detectPromptCommand(message, options)
  if (promptCommand) return json(200, await runPromptCommand(env, chat, message, promptCommand))

  const command = detectCommand(message, { word: env.TRIGGER_WORD, replyPrefix: env.REPLY_PREFIX })
  if (command) {
    await changeSubscription(env.DB, chat.jid, command, Date.now())
    // A failed reaction doesn't undo the change, so it's not retried.
    await wa(env)
      .react(chat.jid, message.id, command === "subscribe" ? env.SUBSCRIBED_EMOJI : env.UNSUBSCRIBED_EMOJI)
      .catch((error) => console.error("reaction failed", error))
    return json(200, { command, chat: chat.jid })
  }

  const trigger = detectTrigger(chat, message, await loadSubscriptions(env.DB), {
    word: env.TRIGGER_WORD,
    replyPrefix: env.REPLY_PREFIX,
  })
  if (!trigger) return json(200, { triggered: false })

  // Answered 200 only once the agent has stored it; otherwise whatsapp-mcp retries.
  const agent = await getAgentByName(env.ChatAgent, chat.jid)
  const accepted = await agent.enqueue(trigger)
  return json(200, { triggered: true, accepted })
}

/** Commands for this chat's instructions. Set and clear react; show and errors reply. */
async function runPromptCommand(
  env: Env,
  chat: ChatRef,
  message: WaMessage,
  command: NonNullable<ReturnType<typeof detectPromptCommand>>,
): Promise<Record<string, unknown>> {
  const client = wa(env)
  const reply = (text: string) =>
    client
      .send({ to: chat.jid, text: `${env.REPLY_PREFIX} ${text}`, reply_to: message.id, idempotency_key: `prompt-${message.id}` })
      .catch((error) => console.error("prompt reply failed", error))
  if (command.action === "show") {
    const current = await getChatInstructions(env.DB, chat.jid)
    await reply(current ? `This chat's instructions:\n\n${current}` : "This chat has no instructions.")
    return { prompt: "show" }
  }
  if (command.action === "set" && !command.text) {
    await reply(`Add the instructions after "set prompt", up to ${MAX_CHAT_INSTRUCTIONS} characters.`)
    return { prompt: "set", saved: false }
  }
  const saved = await setChatInstructions(env.DB, chat.jid, command.action === "set" ? command.text : null, Date.now())
  if (!saved.ok) {
    await reply(`Not saved: ${saved.error}.`)
    return { prompt: command.action, saved: false }
  }
  await client
    .react(chat.jid, message.id, command.action === "set" ? env.SUBSCRIBED_EMOJI : env.UNSUBSCRIBED_EMOJI)
    .catch((error) => console.error("reaction failed", error))
  return { prompt: command.action, saved: true }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/wa/webhook" && request.method === "POST") return webhook(request, env)
    if (path === "/" && request.method === "GET") return new Response("whatsapp-mcp-bot\n")

    if (!authorized(request, env)) return json(401, { error: "unauthorized" })

    if (path === "/subscriptions") {
      if (request.method === "GET") return json(200, await loadSubscriptions(env.DB))
      if (request.method === "PUT") {
        const parsed = parseSubscriptions(await request.json().catch(() => null))
        if (!parsed) return json(400, { error: "expected { chats: string[], allowedSenders?: string[] }" })
        await saveSubscriptions(env.DB, parsed, Date.now())
        return json(200, await loadSubscriptions(env.DB))
      }
    }
    const one = /^\/subscriptions\/chats\/([^/]{1,200})$/.exec(path)
    if (one && (request.method === "POST" || request.method === "DELETE")) {
      const chat = decodeURIComponent(one[1]!)
      return json(200, await changeSubscription(env.DB, chat, request.method === "POST" ? "subscribe" : "unsubscribe", Date.now()))
    }
    const settings = /^\/chats\/([^/]{1,200})\/settings$/.exec(path)
    if (settings) {
      const chat = decodeURIComponent(settings[1]!)
      if (request.method === "GET") return json(200, { chat, instructions: await getChatInstructions(env.DB, chat) })
      if (request.method === "PUT" || request.method === "DELETE") {
        let text: string | null = null
        if (request.method === "PUT") {
          const body = (await request.json().catch(() => null)) as { instructions?: unknown } | null
          if (typeof body?.instructions !== "string") return json(400, { error: "expected { instructions: string }" })
          text = body.instructions
        }
        const saved = await setChatInstructions(env.DB, chat, text, Date.now())
        return saved.ok ? json(200, { chat, instructions: saved.instructions }) : json(400, { error: saved.error })
      }
    }
    if (path === "/chats" && request.method === "GET") {
      return json(200, await wa(env).chats(url.searchParams.toString()))
    }
    if (path === "/usage" && request.method === "GET") {
      const days = clamp(Number(url.searchParams.get("days") ?? 30), 1, 3650)
      const by = url.searchParams.get("by") ?? "day"
      if (!isGroup(by)) return json(400, { error: "by: day, chat, use_case, model, status or chat_type" })
      return json(200, await usageReport(env.DB, days, by, Date.now(), prices(env as unknown as Record<string, string>)))
    }
    if (path === "/usage/recent" && request.method === "GET") {
      return json(200, await recentUsage(env.DB, clamp(Number(url.searchParams.get("limit") ?? 50), 1, 500), prices(env as unknown as Record<string, string>)))
    }
    return json(404, { error: "not found" })
  },
} satisfies ExportedHandler<Env>
