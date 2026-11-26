import { describe, expect, it } from "vitest"

import { requestBody, sha256, type ResponseObject } from "../src/openai"
import { isGroup, usageRow, useCaseOf } from "../src/usage"

const context = { chatJid: "120363000000000001@g.us", chatName: "Friends", chatType: "group", requests: 2 }

describe("usageRow", () => {
  it("takes tokens and tool calls from a finished response", () => {
    const response = {
      id: "resp_1",
      status: "completed",
      model: "gpt-6.1-terra",
      created_at: 1_000,
      completed_at: 1_042,
      usage: {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 800 },
        output_tokens: 300,
        output_tokens_details: { reasoning_tokens: 120 },
        total_tokens: 1500,
      },
      output: [{ type: "web_search_call" }, { type: "web_search_call" }, { type: "image_generation_call" }, { type: "message" }],
    } as unknown as ResponseObject
    expect(usageRow(response, context, Date.UTC(2026, 10, 25))).toMatchObject({
      response_id: "resp_1",
      at: "2026-11-25T00:00:00.000Z",
      chat_name: "Friends",
      model: "gpt-6.1-terra",
      use_case: "image",
      requests: 2,
      input_tokens: 1200,
      cached_tokens: 800,
      output_tokens: 300,
      reasoning_tokens: 120,
      total_tokens: 1500,
      web_searches: 2,
      images: 1,
      seconds: 42,
    })
  })

  it("records a failed response with zeros", () => {
    const row = usageRow({ id: "resp_2", status: "failed" }, context, 0)
    expect(row).toMatchObject({ status: "failed", total_tokens: 0, use_case: "chat", seconds: null })
  })
})

describe("useCaseOf", () => {
  it("names images first, then search", () => {
    expect(useCaseOf(1, 3)).toBe("image")
    expect(useCaseOf(0, 1)).toBe("search")
    expect(useCaseOf(0, 0)).toBe("chat")
  })
})

describe("isGroup", () => {
  it("accepts only known groupings", () => {
    expect(isGroup("chat")).toBe(true)
    expect(isGroup("toString")).toBe(false)
    expect(isGroup("1; DROP TABLE usage")).toBe(false)
  })
})

describe("requestBody attribution", () => {
  it("labels the request without sending raw JIDs", async () => {
    const askerHash = await sha256("15550002222@s.whatsapp.net")
    const chatHash = await sha256(context.chatJid)
    const body = requestBody("m", "input", "Ana", {
      app: "whatsapp-mcp-bot",
      chatType: "group",
      chatName: "Friends",
      requests: 2,
      workflow: "reply-3EB0",
      askerHash,
      chatHash,
    })
    expect(body.metadata).toEqual({
      app: "whatsapp-mcp-bot",
      use: "whatsapp-reply",
      chat_type: "group",
      chat: "Friends",
      requests: "2",
      workflow: "reply-3EB0",
    })
    expect(body.safety_identifier).toBe(askerHash)
    expect(body.prompt_cache_key).toBe(`chat-${chatHash.slice(0, 32)}`)
    expect(JSON.stringify(body)).not.toContain("@s.whatsapp.net")
  })
})
