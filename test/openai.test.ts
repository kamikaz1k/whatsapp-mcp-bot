import { describe, expect, it } from "vitest"

import { buildInput, compactHistory, extractAnswer, formatReply, MAX_REPLY_CHARS, requestBody } from "../src/openai"

describe("compactHistory", () => {
  it("names senders, marks your own messages and keeps the newest when cut", () => {
    const lines = compactHistory(
      [
        { sent_at: "t1", from_me: false, sender: { name: "Ben" }, text: "first", kind: "text" },
        { sent_at: "t2", from_me: true, sender: null, text: "second\nline", kind: "text" },
        { sent_at: "t3", from_me: false, sender: { phone: "1555" }, text: null, kind: "image", description: "a dog" },
      ],
      "Ana",
    )
    expect(lines.map((line) => `${line.who}: ${line.text}`)).toEqual([
      "Ben: first",
      "Ana (me): second line",
      "1555: a dog",
    ])
    const many = Array.from({ length: 500 }, (_, i) => ({ sent_at: `t${i}`, from_me: false, sender: { name: "A" }, text: "x".repeat(100) }))
    const kept = compactHistory(many, "Ana")
    expect(kept.length).toBeLessThan(500)
    expect(kept[kept.length - 1]!.at).toBe("t499")
  })
})

describe("requests", () => {
  it("runs in background with web search and image generation", () => {
    const body = requestBody("gpt-6.1-terra", "hi", "Ana")
    expect(body.background).toBe(true)
    expect(body.store).toBe(true)
    expect(body.tools).toEqual([{ type: "web_search" }, { type: "image_generation" }])
  })

  it("lists every request in a batch", () => {
    const input = buildInput("Friends", [], [
      { id: "1", chat: { jid: "g", name: "Friends", type: "group" }, sender: { jid: "b", name: "Ben", phone: null }, fromMe: false, sentAt: "", prompt: "summarize", replyTo: null },
      { id: "2", chat: { jid: "g", name: "Friends", type: "group" }, sender: null, fromMe: true, sentAt: "", prompt: "and draw it", replyTo: null },
    ], "Ana")
    expect(input).toContain("Requests for you:\n- Ben: summarize\n- Ana (me): and draw it")
  })
})

describe("extractAnswer and formatReply", () => {
  it("joins text and collects images", () => {
    const answer = extractAnswer({
      id: "resp_1",
      status: "completed",
      output: [
        { type: "web_search_call" },
        { type: "image_generation_call", result: "aGk=", output_format: "webp" },
        { type: "message", content: [{ type: "output_text", text: "Here " }, { type: "output_text", text: "you go" }] },
      ],
    })
    expect(answer.text).toBe("Here you go")
    expect(answer.images).toEqual([{ base64: "aGk=", format: "webp" }])
    expect(formatReply("🤖", answer, ["https://x/img/a.webp"])).toBe("🤖 Here you go\n\nhttps://x/img/a.webp")
  })

  it("cuts long answers", () => {
    const reply = formatReply("🤖", { text: "y".repeat(MAX_REPLY_CHARS + 50), images: [] }, [])
    expect(reply.length).toBeLessThanOrEqual(MAX_REPLY_CHARS + 4)
    expect(reply.endsWith("…")).toBe(true)
  })
})
