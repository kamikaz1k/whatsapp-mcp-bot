// whatsapp-mcp-bot: answers WhatsApp requests addressed to you ("@you bot …").
//
//   POST /wa/webhook        signed events from whatsapp-mcp → ChatAgent per chat
//   GET  /subscriptions     which chats others may call the bot from (Bearer BOT_SECRET)
//   PUT  /subscriptions     replace them: { chats: [...], allowedSenders: [...] }
//   GET  /chats             your chats from whatsapp-mcp, to find JIDs (?type=group|direct)
//   GET  /usage             token totals: ?days=30&by=day|chat|use_case|model|status|chat_type
//   GET  /usage/recent      the latest replies' usage, ?limit=50
import { getAgentByName } from "agents"

import type { Env } from "./env"
import { detectTrigger, type ChatRef, type Subscriptions, type WaMessage } from "./trigger"
import { isGroup, prices, recentUsage, usageReport } from "./usage"
import { wa } from "./wa"
import { verifyWebhook } from "./webhook"

export { ChatAgent } from "./agent"
export { ReplyWorkflow } from "./workflow"

const SUBSCRIPTIONS_KEY = "config:subscriptions"
const EMPTY: Subscriptions = { chats: [], allowedSenders: [] }

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

export async function loadSubscriptions(env: Env): Promise<Subscriptions> {
  const stored = await env.BOT_KV.get<Subscriptions>(SUBSCRIPTIONS_KEY, "json")
  return {
    chats: stored?.chats ?? EMPTY.chats,
    allowedSenders: stored?.allowedSenders ?? EMPTY.allowedSenders,
  }
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

  const trigger = detectTrigger(chat, message, await loadSubscriptions(env), {
    word: env.TRIGGER_WORD,
    replyPrefix: env.REPLY_PREFIX,
  })
  if (!trigger) return json(200, { triggered: false })

  // Answered 200 only once the agent has stored it; otherwise whatsapp-mcp retries.
  const agent = await getAgentByName(env.ChatAgent, chat.jid)
  const accepted = await agent.enqueue(trigger)
  return json(200, { triggered: true, accepted })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/wa/webhook" && request.method === "POST") return webhook(request, env)
    if (path === "/" && request.method === "GET") return new Response("whatsapp-mcp-bot\n")

    if (!authorized(request, env)) return json(401, { error: "unauthorized" })

    if (path === "/subscriptions") {
      if (request.method === "GET") return json(200, await loadSubscriptions(env))
      if (request.method === "PUT") {
        const parsed = parseSubscriptions(await request.json().catch(() => null))
        if (!parsed) return json(400, { error: "expected { chats: string[], allowedSenders?: string[] }" })
        await env.BOT_KV.put(SUBSCRIPTIONS_KEY, JSON.stringify(parsed))
        return json(200, parsed)
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
