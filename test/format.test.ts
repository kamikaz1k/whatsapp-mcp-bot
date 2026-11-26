import { describe, expect, it } from "vitest"

import { citedUrls, whatsappText } from "../src/format"
import { replyParts } from "../src/openai"

describe("whatsappText", () => {
  it("drops web search citations and tidies what's left", () => {
    expect(
      whatsappText(
        "Walk-ins are welcome for lunch. ([guide.michelin.com](https://guide.michelin.com/ca/en/pai?utm_source=openai))",
      ),
    ).toBe("Walk-ins are welcome for lunch.")
    expect(
      whatsappText("It's 4°C ([weather.gc.ca](https://weather.gc.ca/x), [theweathernetwork.com](https://www.theweathernetwork.com/y)).\nNext"),
    ).toBe("It's 4°C.\nNext")
    expect(whatsappText("Cloudy [1](https://a.example/x) today")).toBe("Cloudy today")
  })

  it("keeps a link's words and bare URLs, without tracking", () => {
    expect(whatsappText("Read [the guide](https://a.example/g) first")).toBe("Read the guide first")
    expect(whatsappText("Sources:\nhttps://a.example/x?utm_source=openai\nhttps://b.example/y?id=1&utm_source=openai"))
      .toBe("Sources:\nhttps://a.example/x\nhttps://b.example/y?id=1")
  })

  it("turns Markdown into WhatsApp formatting, leaving code alone", () => {
    expect(whatsappText("## Plan\n**Bold** and ~~gone~~\n\n\n---\n- item")).toBe("*Plan*\n*Bold* and ~gone~\n\n- item")
    expect(whatsappText("```\n**raw** [x](https://a.example)\n```")).toBe("```\n**raw** [x](https://a.example)\n```")
  })

  it("is applied to every reply", () => {
    expect(replyParts("🤖", "**Hi** ([a.com](https://a.com))", 0)).toEqual([{ text: "🤖 *Hi*" }])
  })
})

describe("citedUrls", () => {
  it("keeps the links whatsappText drops, deduplicated and without tracking", () => {
    expect(citedUrls("A ([a.com](https://a.com/x?utm_source=openai)) B [b](https://b.com) [a](https://a.com/x)")).toEqual([
      "https://a.com/x",
      "https://b.com",
    ])
  })
})
