// Answers one batch of requests in one chat. Every step's result is saved by Workflows,
// so a redeploy resumes at the next step instead of starting over:
//
//   context → start (OpenAI background response) → wait/poll … → reply → reportComplete
//
// The OpenAI generation runs on OpenAI's side; only its id is kept here. Images are
// written to KV inside the poll step, so only their keys pass through step results.
import { NonRetryableError } from "cloudflare:workflows"
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep, type DefaultProgress } from "agents/workflows"

import type { ChatAgent, ReplyParams } from "./agent"
import type { Env } from "./env"
import { buildInput, compactHistory, extractAnswer, formatReply, openai, OpenAIError, requestBody } from "./openai"
import { permanent, wa } from "./wa"

const RETRY = {
  retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const

const IMAGE_TTL_SECONDS = 30 * 24 * 60 * 60
const HISTORY_MESSAGES = 40
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
}

export class ReplyWorkflow extends AgentWorkflow<ChatAgent, ReplyParams, DefaultProgress, Env> {
  async run(event: AgentWorkflowEvent<ReplyParams>, step: AgentWorkflowStep): Promise<void> {
    const { chatJid, chatName, triggers } = event.payload
    const env = this.env
    const last = triggers[triggers.length - 1]!

    const input = await step.do("context", RETRY, async () => {
      try {
        const { messages } = await wa(env).messages(chatJid, HISTORY_MESSAGES)
        await wa(env).typing(chatJid).catch(() => {})
        return buildInput(chatName, compactHistory(messages, env.OWNER_NAME), triggers, env.OWNER_NAME)
      } catch (error) {
        return nonRetryable(error)
      }
    })

    const responseId = await step.do("start", RETRY, async () => {
      try {
        return (await openai(env.OPENAI_API_KEY).start(requestBody(env.OPENAI_MODEL, input, env.OWNER_NAME))).id
      } catch (error) {
        return nonRetryable(error)
      }
    })

    let result: Polled = { done: false }
    for (let attempt = 0; attempt < POLLS && !result.done; attempt++) {
      await step.sleep(`wait-${attempt}`, pollDelay(attempt))
      result = await step.do(`poll-${attempt}`, RETRY, async (): Promise<Polled> => {
        let response
        try {
          response = await openai(env.OPENAI_API_KEY).get(responseId)
        } catch (error) {
          return nonRetryable(error)
        }
        if (response.status === "queued" || response.status === "in_progress") return { done: false }
        if (response.status !== "completed") {
          const why = response.error?.message ?? response.incomplete_details?.reason ?? response.status
          throw new NonRetryableError(`OpenAI response ${response.status}: ${why}`)
        }
        const answer = extractAnswer(response)
        const imageKeys: string[] = []
        for (const [index, image] of answer.images.entries()) {
          const key = `${responseId}-${index}.${image.format}`
          const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0))
          await env.BOT_KV.put(`img:${key}`, bytes, {
            expirationTtl: IMAGE_TTL_SECONDS,
            metadata: { contentType: `image/${image.format === "jpg" ? "jpeg" : image.format}` },
          })
          imageKeys.push(key)
        }
        return { done: true, text: answer.text, imageKeys }
      })
    }
    if (!result.done) throw new NonRetryableError("OpenAI took too long")

    await step.do("reply", RETRY, async () => {
      const urls = (result.imageKeys ?? []).map((key) => `${env.BOT_URL.replace(/\/$/, "")}/img/${key}`)
      const text = formatReply(env.REPLY_PREFIX, { text: result.text ?? "", images: [] }, urls)
      try {
        const sent = await wa(env).send({
          to: chatJid,
          text,
          reply_to: last.id,
          idempotency_key: `reply-${last.id}`,
        })
        return sent.id
      } catch (error) {
        return nonRetryable(error)
      }
    })

    await step.reportComplete({ responseId })
  }
}
