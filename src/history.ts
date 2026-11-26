// The read_chat_history tool: older messages of the chat a request came from, by keyword
// search or by time. Never another chat, so nothing from elsewhere is posted here.
import { compactHistory } from "./openai"
import type { wa } from "./wa"

/** Most characters of history one call hands the model (about 15k tokens). */
export const MAX_TOOL_HISTORY_CHARS = 60_000
const MAX_SEARCH = 100
const MAX_READ = 1000

export interface HistoryArgs {
  readonly query: string | null
  readonly before: string | null
  readonly after: string | null
  readonly limit: number
}

/** Parses the model's arguments; bad times are dropped, the limit clamped. */
export function historyArgs(raw: string): HistoryArgs | null {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const time = (value: unknown) =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null
  const query = typeof args.query === "string" && args.query.trim() ? args.query.trim().slice(0, 500) : null
  const max = query ? MAX_SEARCH : MAX_READ
  const asked = Number(args.limit)
  const limit = Math.min(max, Math.max(1, Math.floor(Number.isFinite(asked) ? asked : 100)))
  return { query, before: time(args.before), after: time(args.after), limit }
}

export async function readHistory(
  client: ReturnType<typeof wa>,
  chatJid: string,
  args: HistoryArgs,
  ownerName: string,
): Promise<Record<string, unknown>> {
  const range = {
    ...(args.after ? { since: args.after } : {}),
    ...(args.before ? { until: args.before } : {}),
  }
  const { messages } = args.query
    ? await client.search(chatJid, args.query, args.limit, range)
    : await client.messages(chatJid, args.limit, range)
  // Search hits come best first; compactHistory keeps the end of the list when it cuts,
  // so hand it the best ones last.
  const ordered = args.query ? [...messages].reverse() : messages
  let lines = compactHistory(ordered, ownerName, MAX_TOOL_HISTORY_CHARS)
  if (args.query) lines = [...lines].reverse()
  const times = lines.map((line) => line.at).filter(Boolean).sort()
  return {
    mode: args.query ? "search" : "read",
    found: messages.length,
    shown: lines.length,
    cut: lines.length < messages.filter((message) => message.deleted !== true).length,
    oldest_at: times[0] ?? null,
    newest_at: times[times.length - 1] ?? null,
    messages: lines,
  }
}
