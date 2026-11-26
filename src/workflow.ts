// Answers one batch of requests in one chat. Every step's result is saved by Workflows,
// so a redeploy resumes at the next step instead of starting over:
//
//   context → start (OpenAI background response) → wait/poll … → reply → reportComplete
//
// The OpenAI generation runs on OpenAI's side; only its id is kept here. Generated
// images are written to KV inside the poll step (step results are capped at 1 MiB),
// then each reply message is its own step, so a retry never posts twice.
import { NonRetryableError } from "cloudflare:workflows"
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep, type DefaultProgress } from "agents/workflows"

import type { ChatAgent, ReplyParams } from "./agent"
import type { Env } from "./env"
import {
  buildInput,
  chatLine,
  type ChatLine,
  compactHistory,
  extractAnswer,
  type FunctionCall,
  functionCalls,
  openai,
  OpenAIError,
  replyParts,
  requestBody,
  sha256,
  USAGE_TOOL,
} from "./openai"
import { loadSubscriptions } from "./subscriptions"
import { listed } from "./trigger"
import { isGroup, prices, recordUsage, usageReport, usageRow } from "./usage"
import { permanent, wa } from "./wa"

const RETRY = {
  retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const

/** Generated images only need to outlive the workflow that sends them. */
const IMAGE_TTL_SECONDS = 24 * 60 * 60
const HISTORY_MESSAGES = 40
/** How far up a reply chain the context follows (reply to a reply to …). */
const QUOTE_DEPTH = 4
/** Poll schedule: quick at first, then every 15 s, for about 14 minutes in all. */
const POLLS = 60

function pollDelay(attempt: number): "5 seconds" | "15 seconds" {
  return attempt < 6 ? "5 seconds" : "15 seconds"
}

/** Client errors from OpenAI or whatsapp-mcp won't fix themselves: stop retrying. */
function nonRetryable(error: unknown): never {
  if (permanent(error) || (error instanceof OpenAIError && error.status >= 400 && error.status < 500 && error.status !== 429)) {
    throw new NonRetryableError(String(error))
  }
  throw error
}

interface Polled {
  readonly done: boolean
  readonly text?: string
  readonly imageKeys?: readonly string[]
  /** Function calls to run before the answer can finish. */
  readonly calls?: readonly FunctionCall[]
}

/** Function-call rounds per reply before giving up (each is a new OpenAI response). */
const TOOL_ROUNDS = 3

/** Step names for round 0 stay as they were, so instances started before tools resume. */
const named = (round: number, name: string) => (round === 0 ? name : `${name}-r${round}`)

export class ReplyWorkflow extends AgentWorkflow<ChatAgent, ReplyParams, DefaultProgress, Env> {
  async run(event: AgentWorkflowEvent<ReplyParams>, step: AgentWorkflowStep): Promise<void> {
    const { chatJid, chatName, triggers } = event.payload
    const env = this.env
    const last = triggers[triggers.length - 1]!

    // The messages a reply quotes, oldest first. A quoted message the archive doesn't
    // have (older than the history sync) ends the chain; it never fails the reply.
    const thread = async (chat: string, id: string): Promise<ChatLine[]> => {
      const lines: ChatLine[] = []
      let next: string | null = id
      for (let depth = 0; next && depth < QUOTE_DEPTH; depth++) {
        let message: Record<string, unknown>
        try {
          message = (await wa(env).message(chat, next)).message
        } catch (error) {
          if (permanent(error)) break
          throw error
        }
        // A message deleted for everyone ends the thread too.
        const line = chatLine(message, env.OWNER_NAME)
        if (!line) break
        lines.unshift(line)
        next = typeof message.reply_to === "string" ? message.reply_to : null
      }
      return lines
    }

    const input = await step.do("context", RETRY, async () => {
      try {
        const { messages } = await wa(env).messages(chatJid, HISTORY_MESSAGES)
        await wa(env).typing(chatJid).catch(() => {})
        const quoted: Record<string, ChatLine[]> = {}
        for (const trigger of triggers) {
          if (trigger.replyTo) quoted[trigger.id] = await thread(chatJid, trigger.replyTo)
        }
        return buildInput(chatName, compactHistory(messages, env.OWNER_NAME), triggers, env.OWNER_NAME, quoted)
      } catch (error) {
        return nonRetryable(error)
      }
    })

    const chatType = last.chat.type
    const client = openai(env.OPENAI_API_KEY, { project: env.OPENAI_PROJECT || undefined })

    // Usage stats are the owner's: the tool is only offered when every request is yours.
    const ownerOnly = triggers.every((trigger) => trigger.fromMe)
    const functions = ownerOnly ? [USAGE_TOOL] : []
    const attribution = {
      app: "whatsapp-mcp-bot",
      chatType,
      chatName,
      requests: triggers.length,
      workflow: event.instanceId,
      askerHash: await sha256(last.fromMe ? "me" : (last.sender?.jid ?? "someone")),
      chatHash: await sha256(chatJid),
    }

    const runFunction = async (call: FunctionCall): Promise<string> => {
      if (call.name !== USAGE_TOOL.name || !ownerOnly) return JSON.stringify({ error: `unknown function ${call.name}` })
      let args: { days?: unknown; by?: unknown }
      try {
        args = JSON.parse(call.arguments) as typeof args
      } catch {
        return JSON.stringify({ error: "arguments are not JSON" })
      }
      const days = Math.min(365, Math.max(1, Math.floor(Number(args.days) || 30)))
      const by = typeof args.by === "string" && isGroup(args.by) ? args.by : "day"
      // The answer is posted in this chat: outside your own "message yourself" chat it only
      // covers this chat, so other chats' names and activity never show up in a group.
      const me = await wa(env).me()
      const selfChat = chatJid === me.jid || chatJid === me.lid
      const report = await usageReport(
        env.DB,
        days,
        by,
        Date.now(),
        prices(env as unknown as Record<string, string>),
        selfChat ? undefined : chatJid,
      )
      return JSON.stringify(report)
    }

    const howTo = async () => ({
      word: env.TRIGGER_WORD,
      chatType,
      subscribed: listed((await loadSubscriptions(env.DB)).chats, chatJid),
    })

    let responseId = await step.do("start", RETRY, async () => {
      try {
        const body = requestBody(env.OPENAI_MODEL, input, env.OWNER_NAME, { attribution, functions, howTo: await howTo() })
        return (await client.start(body, event.instanceId)).id
      } catch (error) {
        return nonRetryable(error)
      }
    })

    let result: Polled = { done: false }
    for (let round = 0; ; round++) {
      result = { done: false }
      const id = responseId
      for (let attempt = 0; attempt < POLLS && !result.done; attempt++) {
        await step.sleep(named(round, `wait-${attempt}`), pollDelay(attempt))
        result = await step.do(named(round, `poll-${attempt}`), RETRY, async (): Promise<Polled> => {
          let response
          try {
            response = await client.get(id)
          } catch (error) {
            return nonRetryable(error)
          }
          if (response.status === "queued" || response.status === "in_progress") return { done: false }
          // Stats must never cost the reply: a failed write is logged, not retried.
          await recordUsage(
            env.DB,
            usageRow(response, { chatJid, chatName, chatType, requests: triggers.length }, Date.now()),
          ).catch((error) => console.error("usage not recorded", error))
          if (response.status !== "completed") {
            const why = response.error?.message ?? response.incomplete_details?.reason ?? response.status
            throw new NonRetryableError(`OpenAI response ${response.status}: ${why}`)
          }
          const calls = functionCalls(response)
          if (calls.length > 0) return { done: true, calls }
          const answer = extractAnswer(response)
          const imageKeys: string[] = []
          for (const [index, image] of answer.images.entries()) {
            const key = `img:${id}:${index}`
            await env.BOT_KV.put(key, image.base64, { expirationTtl: IMAGE_TTL_SECONDS })
            imageKeys.push(key)
          }
          return { done: true, text: answer.text, imageKeys }
        })
      }
      if (!result.done) throw new NonRetryableError("OpenAI took too long")
      if (!result.calls) break
      if (round + 1 >= TOOL_ROUNDS) throw new NonRetryableError("too many tool rounds")

      const calls = result.calls
      responseId = await step.do(named(round + 1, "start"), RETRY, async () => {
        try {
          const outputs = []
          for (const call of calls) {
            outputs.push({ type: "function_call_output", call_id: call.call_id, output: await runFunction(call) })
          }
          const body = requestBody(env.OPENAI_MODEL, outputs, env.OWNER_NAME, {
            attribution,
            functions,
            previousResponseId: id,
            howTo: await howTo(),
          })
          return (await client.start(body, event.instanceId)).id
        } catch (error) {
          return nonRetryable(error)
        }
      })
    }

    const imageKeys = result.imageKeys ?? []
    const parts = replyParts(env.REPLY_PREFIX, result.text ?? "", imageKeys.length)
    for (const [index, part] of parts.entries()) {
      await step.do(`reply-${index}`, RETRY, async () => {
        try {
          let image: { base64: string } | undefined
          if ("image" in part) {
            const base64 = await env.BOT_KV.get(imageKeys[part.image]!)
            if (!base64) throw new NonRetryableError("generated image expired before it was sent")
            image = { base64 }
          }
          const sent = await wa(env).send({
            to: chatJid,
            text: "image" in part ? part.caption : part.text,
            ...(image ? { image } : {}),
            reply_to: last.id,
            idempotency_key: `reply-${last.id}-${index}`,
          })
          return sent.id
        } catch (error) {
          return nonRetryable(error)
        }
      })
    }

    await step.reportComplete({ responseId })
  }
}
