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
  readonly cache_write_tokens: number
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
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
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
    cache_write_tokens: n(usage.input_tokens_details?.cache_write_tokens),
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
/** Columns added after the table first shipped. */
const ADDED = ["ALTER TABLE usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0"]

async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([db.prepare(SCHEMA), db.prepare(INDEX)])
  for (const statement of ADDED) {
    await db.prepare(statement).run().catch((error: unknown) => {
      if (!String(error).includes("duplicate column")) throw error
    })
  }
}

/**
 * USD prices for the cost estimate, from vars. Defaults are gpt-6.1-terra's list prices
 * (per million tokens) and rough per-call tool prices. Only an estimate: long-context
 * (272k+) rates, and the image tool's own token pricing, aren't modelled.
 */
export interface Prices {
  readonly inputPerM: number
  readonly cachedPerM: number
  readonly cacheWritePerM: number
  readonly outputPerM: number
  readonly perWebSearch: number
  readonly perImage: number
}

export function prices(env: Partial<Record<string, string>>): Prices {
  const price = (name: string, fallback: number) => {
    const value = Number(env[name])
    return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    inputPerM: price("PRICE_INPUT_PER_M", 1),
    cachedPerM: price("PRICE_CACHED_INPUT_PER_M", 0.05),
    cacheWritePerM: price("PRICE_CACHE_WRITE_PER_M", 1.25),
    outputPerM: price("PRICE_OUTPUT_PER_M", 5),
    perWebSearch: price("PRICE_PER_WEB_SEARCH", 0.01),
    perImage: price("PRICE_PER_IMAGE", 0.04),
  }
}

/** Cost of one row, in USD. Input tokens include the cached and cache-write ones. */
export function cost(row: Pick<UsageRow, "input_tokens" | "cached_tokens" | "cache_write_tokens" | "output_tokens" | "web_searches" | "images">, p: Prices): number {
  const fresh = Math.max(0, row.input_tokens - row.cached_tokens - row.cache_write_tokens)
  return (
    (fresh * p.inputPerM + row.cached_tokens * p.cachedPerM + row.cache_write_tokens * p.cacheWritePerM +
      row.output_tokens * p.outputPerM) / 1e6 +
    row.web_searches * p.perWebSearch +
    row.images * p.perImage
  )
}

/** The same formula in SQL, summed over rows. Prices are numbers, so inlining them is safe. */
function costSql(p: Prices): string {
  const num = (value: number) => String(Number(value))
  return `ROUND(SUM(
    (MAX(0, input_tokens - cached_tokens - cache_write_tokens) * ${num(p.inputPerM)}
      + cached_tokens * ${num(p.cachedPerM)} + cache_write_tokens * ${num(p.cacheWritePerM)}
      + output_tokens * ${num(p.outputPerM)}) / 1000000.0
    + web_searches * ${num(p.perWebSearch)} + images * ${num(p.perImage)}), 4)`
}

const COLUMNS = [
  "response_id", "at", "chat_jid", "chat_name", "chat_type", "model", "status", "use_case", "requests",
  "input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens", "total_tokens", "web_searches",
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

const TOTALS = (p: Prices) => `COUNT(*) AS responses, SUM(input_tokens) AS input_tokens,
  SUM(cached_tokens) AS cached_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
  SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
  SUM(total_tokens) AS total_tokens, SUM(web_searches) AS web_searches, SUM(images) AS images,
  ${costSql(p)} AS est_cost_usd, ROUND(AVG(seconds), 1) AS avg_seconds`

/** Totals over the last `days`, overall and one row per group, with an estimated cost. */
/** With `chatJid`, only that chat's rows count. */
export async function usageReport(db: D1Database, days: number, by: Group, now: number, p: Prices, chatJid?: string) {
  await ensureSchema(db)
  const since = new Date(now - days * 86_400_000).toISOString()
  const where = chatJid ? "at >= ? AND chat_jid = ?" : "at >= ?"
  const binds = chatJid ? [since, chatJid] : [since]
  const [total, groups] = await db.batch([
    db.prepare(`SELECT ${TOTALS(p)} FROM usage WHERE ${where}`).bind(...binds),
    db.prepare(`SELECT ${GROUPS[by]} AS "group", ${TOTALS(p)} FROM usage WHERE ${where}
      GROUP BY 1 ORDER BY est_cost_usd DESC`).bind(...binds),
  ])
  return {
    since,
    by,
    scope: chatJid ? "this chat only" : "all chats",
    prices: p,
    total: total!.results[0] ?? null,
    groups: groups!.results,
  }
}

/** The latest responses, newest first, each with its estimated cost. */
export async function recentUsage(db: D1Database, limit: number, p: Prices) {
  await ensureSchema(db)
  const { results } = await db.prepare("SELECT * FROM usage ORDER BY at DESC LIMIT ?").bind(limit).all<UsageRow>()
  return { prices: p, responses: results.map((row) => ({ ...row, est_cost_usd: Number(cost(row, p).toFixed(4)) })) }
}
