// Verifies Standard Webhooks signatures (https://www.standardwebhooks.com), the format
// whatsapp-mcp signs its deliveries with. Signed content is "{id}.{timestamp}.{body}".

const PREFIX = "whsec_"
const TOLERANCE_SECONDS = 5 * 60

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function sign(secret: string, content: string): Promise<string> {
  const raw = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(raw),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content))
  return toBase64(new Uint8Array(mac))
}

export type Verified = { ok: true; id: string } | { ok: false; reason: string }

export async function verifyWebhook(
  secret: string,
  headers: Headers,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Verified> {
  const id = headers.get("webhook-id")
  const timestamp = headers.get("webhook-timestamp")
  const signatures = headers.get("webhook-signature")
  if (!id || !timestamp || !signatures) return { ok: false, reason: "missing headers" }
  const sent = Number(timestamp)
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale timestamp" }
  }
  const expected = await sign(secret, `${id}.${timestamp}.${body}`)
  const matched = signatures
    .split(" ")
    .some((entry) => entry.startsWith("v1,") && equal(entry.slice(3), expected))
  return matched ? { ok: true, id } : { ok: false, reason: "bad signature" }
}
