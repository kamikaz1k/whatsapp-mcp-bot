// Token usage per reply, kept in D1 so it can be reviewed across chats.
//
// OpenAI's own dashboard groups usage only by project, API key, model and the like, not by
// request metadata, so this table is the per-chat, per-use-case record. Each row is one
// OpenAI response; a retried poll step writes the same row again (keyed by response id).
import type { ResponseObject } from "./openai"

export type UseCase = "image" | "search" | "chat"

export interface UsageRow {
  readonly response_id: string
  readonly at: string
  readonly chat_jid: string
  readonly chat_name: string
  readonly chat_type: string
  readonly model: string
  readonly status: string
  readonly use_case: UseCase
  readonly requests: number
  readonly input_tokens: number
  readonly cached_tokens: number
  readonly output_tokens: number
  readonly reasoning_tokens: number
  readonly total_tokens: number
  readonly web_searches: number
  readonly images: number
  readonly seconds: number | null
}

export interface UsageContext {
  readonly chatJid: string
  readonly chatName: string
  readonly chatType: string
  readonly requests: number
}

interface Usage {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
}

const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

export function useCaseOf(images: number, webSearches: number): UseCase {
  if (images > 0) return "image"
  if (webSearches > 0) return "search"
  return "chat"
}

export function usageRow(response: ResponseObject, context: UsageContext, now: number): UsageRow {
  const raw = response as ResponseObject & { usage?: Usage | null; model?: string; created_at?: number; completed_at?: number | null }
  const usage = raw.usage ?? {}
  let webSearches = 0
  let images = 0
  for (const item of response.output ?? []) {
    if (item.type === "web_search_call") webSearches++
    else if (item.type === "image_generation_call") images++
  }
  const end = raw.completed_at ?? Math.floor(now / 1000)
  return {
    response_id: response.id,
    at: new Date(now).toISOString(),
    chat_jid: context.chatJid,
    chat_name: context.chatName,
    chat_type: context.chatType,
    model: raw.model ?? "",
    status: response.status,
    use_case: useCaseOf(images, webSearches),
    requests: context.requests,
    input_tokens: n(usage.input_tokens),
    cached_tokens: n(usage.input_tokens_details?.cached_tokens),
    output_tokens: n(usage.output_tokens),
    reasoning_tokens: n(usage.output_tokens_details?.reasoning_tokens),
    total_tokens: n(usage.total_tokens),
    web_searches: webSearches,
    images,
    seconds: raw.created_at ? Math.max(0, end - raw.created_at) : null,
  }
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS usage (
  response_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  chat_name TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  use_case TEXT NOT NULL,
  requests INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  web_searches INTEGER NOT NULL,
  images INTEGER NOT NULL,
  seconds INTEGER
)`
const INDEX = "CREATE INDEX IF NOT EXISTS usage_at ON usage (at)"

async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([db.prepare(SCHEMA), db.prepare(INDEX)])
}

const COLUMNS = [
  "response_id", "at", "chat_jid", "chat_name", "chat_type", "model", "status", "use_case", "requests",
  "input_tokens", "cached_tokens", "output_tokens", "reasoning_tokens", "total_tokens", "web_searches",
  "images", "seconds",
] as const satisfies readonly (keyof UsageRow)[]

export async function recordUsage(db: D1Database, row: UsageRow): Promise<void> {
  await ensureSchema(db)
  await db
    .prepare(`INSERT OR REPLACE INTO usage (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`)
    .bind(...COLUMNS.map((column) => row[column]))
    .run()
}

/** Ways the report can be grouped. Values are SQL expressions over trusted column names. */
export const GROUPS = {
  day: "substr(at, 1, 10)",
  chat: "chat_name",
  use_case: "use_case",
  model: "model",
  status: "status",
  chat_type: "chat_type",
} as const

export type Group = keyof typeof GROUPS

export function isGroup(value: string): value is Group {
  return Object.hasOwn(GROUPS, value)
}

/** Totals over the last `days`, one row per group. */
export async function usageReport(db: D1Database, days: number, by: Group, now: number) {
  await ensureSchema(db)
  const since = new Date(now - days * 86_400_000).toISOString()
  const { results } = await db
    .prepare(
      `SELECT ${GROUPS[by]} AS "group", COUNT(*) AS replies, SUM(requests) AS requests,
        SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens,
        SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(total_tokens) AS total_tokens, SUM(web_searches) AS web_searches, SUM(images) AS images,
        ROUND(AVG(seconds), 1) AS avg_seconds
       FROM usage WHERE at >= ? GROUP BY 1 ORDER BY total_tokens DESC`,
    )
    .bind(since)
    .all()
  return { since, by, groups: results }
}

/** The latest replies, newest first. */
export async function recentUsage(db: D1Database, limit: number) {
  await ensureSchema(db)
  const { results } = await db.prepare("SELECT * FROM usage ORDER BY at DESC LIMIT ?").bind(limit).all()
  return { replies: results }
}
