import { describe, expect, it } from "vitest"

import { MAX_CHAT_INSTRUCTIONS, setChatInstructions } from "../src/chat-settings"
import { INSTRUCTIONS_TOOL, instructions, requestBody } from "../src/openai"

function fakeDb() {
  const runs: { sql: string; binds: unknown[] }[] = []
  const db = {
    prepare: (sql: string) => {
      const statement = {
        binds: [] as unknown[],
        bind: (...binds: unknown[]) => ((statement.binds = binds), statement),
        run: async () => (runs.push({ sql, binds: statement.binds }), {}),
        first: async () => null,
      }
      return statement
    },
  } as unknown as D1Database
  return { db, runs }
}

describe("setChatInstructions", () => {
  it("saves trimmed text, clears on empty, refuses too long", async () => {
    const { db, runs } = fakeDb()
    expect(await setChatInstructions(db, "c@g.us", "  be a pirate ", 0)).toEqual({ ok: true, instructions: "be a pirate" })
    expect(runs.at(-1)!.binds).toEqual(["c@g.us", "be a pirate", "1970-01-01T00:00:00.000Z"])
    expect(await setChatInstructions(db, "c@g.us", "", 0)).toEqual({ ok: true, instructions: null })
    expect(runs.at(-1)!.sql).toContain("DELETE")
    const long = await setChatInstructions(db, "c@g.us", "x".repeat(MAX_CHAT_INSTRUCTIONS + 1), 0)
    expect(long.ok).toBe(false)
  })
})

describe("chat instructions in the prompt", () => {
  it("come after the fixed rules, fenced, and say when there are none", () => {
    const text = instructions("Ana", undefined, "Talk like a pirate")
    expect(text.indexOf("<chat-instructions>\nTalk like a pirate\n</chat-instructions>")).toBeGreaterThan(text.indexOf("Never claim to be Ana"))
    expect(instructions("Ana", undefined, null)).toContain("no instructions of its own")
    expect(instructions("Ana")).not.toContain("chat-instructions")
  })

  it("are sent in the request, with the owner-only tool when offered", () => {
    const body = requestBody("m", "hi", "Ana", { chatInstructions: "Be brief", functions: [INSTRUCTIONS_TOOL] })
    expect(body.instructions).toContain("Be brief")
    expect((body.tools as { name?: string }[]).some((tool) => tool.name === "update_chat_instructions")).toBe(true)
  })
})
