import { describe, expect, it } from "vitest"

import { historyArgs, MAX_TOOL_HISTORY_CHARS, readHistory } from "../src/history"
import type { wa } from "../src/wa"

const CHAT = "120363000000000000@g.us"

function fakeWa(messages: Record<string, unknown>[]) {
  const calls: { method: string; args: unknown[] }[] = []
  const client = {
    messages: async (...args: unknown[]) => {
      calls.push({ method: "messages", args })
      return { chat: {}, messages }
    },
    search: async (...args: unknown[]) => {
      calls.push({ method: "search", args })
      return { chat: {}, messages }
    },
  } as unknown as ReturnType<typeof wa>
  return { client, calls }
}

const msg = (at: string, text: string, extra: Record<string, unknown> = {}) => ({
  sent_at: at,
  from_me: false,
  sender: { name: "Ben", phone: "15551234567" },
  text,
  kind: "text",
  ...extra,
})

describe("historyArgs", () => {
  it("clamps the limit per mode and drops bad times", () => {
    expect(historyArgs('{"query":null,"before":"2026-11-01T00:00:00Z","after":"nope","limit":5000}')).toEqual({
      query: null,
      before: "2026-11-01T00:00:00.000Z",
      after: null,
      limit: 1000,
    })
    expect(historyArgs('{"query":"  pizza ","before":null,"after":null,"limit":500}')).toMatchObject({
      query: "pizza",
      limit: 100,
    })
    expect(historyArgs('{"query":"","before":null,"after":null,"limit":0}')).toMatchObject({ query: null, limit: 1 })
    expect(historyArgs("not json")).toBeNull()
  })
})

describe("readHistory", () => {
  it("reads back by time, only in the chat it was asked in, with no phone numbers", async () => {
    const { client, calls } = fakeWa([msg("2026-10-01T10:00:00Z", "first"), msg("2026-10-02T10:00:00Z", "call @15551234567")])
    const result = await readHistory(
      client,
      CHAT,
      { query: null, before: "2026-11-01T00:00:00.000Z", after: null, limit: 500 },
      "Ana",
    )
    expect(calls).toEqual([{ method: "messages", args: [CHAT, 500, { until: "2026-11-01T00:00:00.000Z" }] }])
    expect(result).toMatchObject({ mode: "read", found: 2, shown: 2, cut: false, oldest_at: "2026-10-01T10:00:00Z" })
    expect(JSON.stringify(result)).not.toContain("15551234567")
  })

  it("searches, keeping the best matches first and when cut", async () => {
    const big = "x".repeat(MAX_TOOL_HISTORY_CHARS / 2)
    const { client, calls } = fakeWa([msg("2026-10-03T00:00:00Z", `best ${big}`), msg("2026-10-01T00:00:00Z", `second ${big}`), msg("2026-10-02T00:00:00Z", `third ${big}`)])
    const result = await readHistory(client, CHAT, { query: "pizza", before: null, after: null, limit: 25 }, "Ana")
    expect(calls[0]).toEqual({ method: "search", args: [CHAT, "pizza", 25, {}] })
    const lines = result.messages as { text: string }[]
    expect(lines.map((line) => line.text.split(" ")[0])).toEqual(["best"])
    expect(result).toMatchObject({ mode: "search", found: 3, shown: 1, cut: true })
  })

  it("leaves out messages deleted for everyone", async () => {
    const { client } = fakeWa([msg("t1", "kept"), msg("t2", "gone", { deleted: true })])
    const result = await readHistory(client, CHAT, { query: null, before: null, after: null, limit: 10 }, "Ana")
    expect(result).toMatchObject({ found: 2, shown: 1, cut: false })
  })
})
