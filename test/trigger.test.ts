import { describe, expect, it } from "vitest"

import { afterWord, detectTrigger, listed, type ChatRef, type WaMessage } from "../src/trigger"

const group: ChatRef = { jid: "120363000000000001@g.us", name: "Friends", type: "group" }
const dm: ChatRef = { jid: "15550001111@s.whatsapp.net", name: "Ana", type: "direct" }
const options = { word: "bot", replyPrefix: "🤖" }
const subs = { chats: [group.jid, "15550001111"], allowedSenders: [] }

function message(overrides: Partial<WaMessage>): WaMessage {
  return {
    id: "3EB0AAA",
    sent_at: "2026-11-25T10:00:00.000Z",
    from_me: false,
    sender: { jid: "15550002222@s.whatsapp.net", name: "Ben", phone: "15550002222" },
    kind: "text",
    text: "",
    mentions_me: false,
    reply_to: null,
    ...overrides,
  }
}

describe("afterWord", () => {
  it("takes what follows the word", () => {
    expect(afterWord("bot, can you summarize", "bot")).toBe("can you summarize")
    expect(afterWord("  Bot: draw a cat", "bot")).toBe("draw a cat")
    expect(afterWord("bot", "bot")).toBe("")
  })
  it("needs the whole word at the start", () => {
    expect(afterWord("bottle of wine", "bot")).toBeNull()
    expect(afterWord("hey bot do this", "bot")).toBeNull()
  })
})

describe("listed", () => {
  it("matches JIDs exactly and phone numbers by digits", () => {
    expect(listed([group.jid], group.jid)).toBe(true)
    expect(listed(["+1 555 000 1111"], "15550001111@s.whatsapp.net")).toBe(true)
    expect(listed(["15550001111"], "15550009999@s.whatsapp.net")).toBe(false)
  })
})

describe("detectTrigger", () => {
  it("answers a tag followed by the word in a subscribed group", () => {
    const trigger = detectTrigger(
      group,
      message({ text: "@15559990000 bot can you summarize this?", mentions_me: true }),
      subs,
      options,
    )
    expect(trigger?.prompt).toBe("can you summarize this?")
    expect(trigger?.chat.jid).toBe(group.jid)
  })

  it("answers a reply to one of my messages that starts with the word", () => {
    const reply = message({ text: "bot what did you mean?", reply_to: "3EB0MINE", reply_to_me: true })
    expect(detectTrigger(group, reply, subs, options)).toMatchObject({
      prompt: "what did you mean?",
      replyTo: "3EB0MINE",
    })
  })

  it("ignores a reply to me without the word, or in an unsubscribed chat", () => {
    expect(detectTrigger(group, message({ text: "haha true", reply_to_me: true }), subs, options)).toBeNull()
    const other: ChatRef = { jid: "120363000000000009@g.us", name: "Other", type: "group" }
    expect(detectTrigger(other, message({ text: "bot hi", reply_to_me: true }), subs, options)).toBeNull()
  })

  it("ignores a tag without the word, and the word without a tag in a group", () => {
    expect(detectTrigger(group, message({ text: "@15559990000 hi", mentions_me: true }), subs, options)).toBeNull()
    expect(detectTrigger(group, message({ text: "bot do it", mentions_me: false }), subs, options)).toBeNull()
  })

  it("ignores chats that aren't subscribed", () => {
    const other: ChatRef = { jid: "120363999@g.us", name: "Work", type: "group" }
    expect(detectTrigger(other, message({ text: "@me bot hi", mentions_me: true }), subs, options)).toBeNull()
  })

  it("accepts the bare word in a subscribed direct chat", () => {
    const trigger = detectTrigger(dm, message({ text: "bot what's the weather" }), subs, options)
    expect(trigger?.prompt).toBe("what's the weather")
  })

  it("lets you trigger it yourself in any chat", () => {
    const other: ChatRef = { jid: "120363999@g.us", name: "Work", type: "group" }
    const trigger = detectTrigger(other, message({ text: "bot summarize the above", from_me: true }), subs, options)
    expect(trigger?.prompt).toBe("summarize the above")
    expect(trigger?.fromMe).toBe(true)
  })

  it("never answers its own replies", () => {
    expect(detectTrigger(group, message({ text: "🤖 bot here", from_me: true }), subs, options)).toBeNull()
  })

  it("respects the sender allowlist", () => {
    const strict = { ...subs, allowedSenders: ["15550003333"] }
    expect(detectTrigger(group, message({ text: "@me bot hi", mentions_me: true }), strict, options)).toBeNull()
    const ok = message({
      text: "@me bot hi",
      mentions_me: true,
      sender: { jid: "15550003333@s.whatsapp.net", name: "Cy", phone: "15550003333" },
    })
    expect(detectTrigger(group, ok, strict, options)).not.toBeNull()
  })

  it("uses a voice note's transcript when there's no text", () => {
    const trigger = detectTrigger(dm, message({ kind: "voice", text: null, transcript: "Bot, remind me" }), subs, options)
    expect(trigger?.prompt).toBe("remind me")
  })
})
