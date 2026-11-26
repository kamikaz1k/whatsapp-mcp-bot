import { describe, expect, it } from "vitest"

import { buildInput, chatLine, compactHistory, extractAnswer, MAX_CAPTION_CHARS, MAX_REPLY_CHARS, replyParts, requestBody } from "../src/openai"

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

describe("extractAnswer", () => {
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
  })
})

describe("replyParts", () => {
  it("is one text message without images", () => {
    expect(replyParts("🤖", "Here you go", 0)).toEqual([{ text: "🤖 Here you go" }])
    expect(replyParts("🤖", "", 0)).toEqual([{ text: "🤖 (no answer)" }])
  })

  it("puts a short answer on the first photo, and the prefix on the rest", () => {
    expect(replyParts("🤖", "A cat", 2)).toEqual([
      { image: 0, caption: "🤖 A cat" },
      { image: 1, caption: "🤖" },
    ])
  })

  it("sends a long answer as text before the photos", () => {
    const long = "z".repeat(MAX_CAPTION_CHARS + 1)
    expect(replyParts("🤖", long, 1)).toEqual([{ text: `🤖 ${long}` }, { image: 0, caption: "🤖" }])
  })

  it("cuts very long answers", () => {
    const [part] = replyParts("🤖", "y".repeat(MAX_REPLY_CHARS + 50), 0)
    expect("text" in part! && part.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS + 4)
    expect("text" in part! && part.text.endsWith("…")).toBe(true)
  })

  it("never starts a message with the trigger word", () => {
    for (const part of replyParts("🤖", "bot answers", 2)) {
      expect(("text" in part ? part.text : part.caption).startsWith("🤖")).toBe(true)
    }
  })
})

describe("buildInput with a reply thread", () => {
  const trigger = {
    id: "3EB0ASK",
    chat: { jid: "g@g.us", name: "Friends", type: "group" },
    sender: { jid: "1@s.whatsapp.net", name: "Ben", phone: "1" },
    fromMe: false,
    sentAt: "2026-11-25T10:00:00.000Z",
    prompt: "what did you mean?",
    replyTo: "3EB0BOT",
  }

  it("shows the quoted messages under the request, oldest first", () => {
    const thread = [
      chatLine({ from_me: true, text: "bot best pizza in Toronto?", sent_at: "t1" }, "Ana"),
      chatLine({ from_me: true, text: "🤖 Try Pizzeria Libretto.", sent_at: "t2" }, "Ana"),
    ]
    const input = buildInput("Friends", [], [trigger], "Ana", { "3EB0ASK": thread })
    expect(input).toContain(
      "- Ben: what did you mean?\n  in reply to:\n    [t1] Ana (me): bot best pizza in Toronto?\n    [t2] Ana (me): 🤖 Try Pizzeria Libretto.",
    )
  })

  it("cuts a long quoted message", () => {
    expect(chatLine({ text: "x".repeat(5000) }, "Ana").text).toHaveLength(2001)
  })
})

describe("replyParts prefix", () => {
  it("drops a prefix the model copied", () => {
    expect(replyParts("🤖", "🤖 🤖 hi", 0)).toEqual([{ text: "🤖 hi" }])
  })
})
