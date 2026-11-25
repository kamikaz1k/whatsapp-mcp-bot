import { describe, expect, it } from "vitest"

import { sign, verifyWebhook } from "../src/webhook"

const secret = "whsec_" + btoa("0123456789abcdef01234567")

async function headersFor(id: string, timestamp: number, body: string, key = secret): Promise<Headers> {
  return new Headers({
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${await sign(key, `${id}.${timestamp}.${body}`)}`,
  })
}

describe("verifyWebhook", () => {
  const now = 1_800_000_000
  const body = JSON.stringify({ type: "message.received" })

  it("accepts a correct signature", async () => {
    const result = await verifyWebhook(secret, await headersFor("evt_1", now, body), body, now)
    expect(result).toEqual({ ok: true, id: "evt_1" })
  })

  it("rejects a changed body, a wrong key and an old timestamp", async () => {
    expect((await verifyWebhook(secret, await headersFor("evt_1", now, body), body + " ", now)).ok).toBe(false)
    const otherKey = "whsec_" + btoa("ffffffffffffffffffffffff")
    expect((await verifyWebhook(secret, await headersFor("evt_1", now, body, otherKey), body, now)).ok).toBe(false)
    expect((await verifyWebhook(secret, await headersFor("evt_1", now - 600, body), body, now)).ok).toBe(false)
  })

  it("accepts any of several signatures (secret rotation)", async () => {
    const headers = await headersFor("evt_2", now, body)
    headers.set("webhook-signature", `v1,bm90LWl0 ${headers.get("webhook-signature")}`)
    expect((await verifyWebhook(secret, headers, body, now)).ok).toBe(true)
  })
})
