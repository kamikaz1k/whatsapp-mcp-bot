// A small client for whatsapp-mcp's REST API (`/accounts/<id>/...`, Bearer SECRET).

export interface WaEnv {
  /** whatsapp-mcp's URL, needed only without the `WA` service binding. */
  readonly WA_API_URL?: string
  readonly WA_API_SECRET: string
  readonly WA_ACCOUNT: string
  /** Service binding to whatsapp-mcp. Needed when both run on one account: a Worker can't
   * fetch another Worker of the same account through its workers.dev URL (it gets a 404). */
  readonly WA?: Fetcher
}

export class WaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
  }
}

export interface SendResult {
  readonly chat_jid: string
  readonly id: string
  readonly deduplicated: boolean
}

export function wa(env: WaEnv) {
  // Through the binding the host is never resolved, so any one does.
  const origin = env.WA ? "https://whatsapp-mcp" : env.WA_API_URL?.replace(/\/$/, "")
  if (!origin) throw new Error("set the WA service binding or the WA_API_URL secret")
  const base = `${origin}/accounts/${env.WA_ACCOUNT}`

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await (env.WA ? env.WA.fetch.bind(env.WA) : fetch)(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.WA_API_SECRET}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { error?: string; code?: string } | null
      throw new WaError(
        response.status,
        error?.code ?? null,
        `whatsapp-mcp ${method} ${path}: ${response.status} ${error?.error ?? ""}`.trim(),
      )
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  const enc = encodeURIComponent
  return {
    react: (chat: string, id: string, emoji: string) =>
      call<void>("PUT", `/messages/${enc(chat)}/${enc(id)}/reaction`, { emoji }),
    send: (body: {
      to: string
      text: string
      /** A photo sent inline; `text` becomes its caption. */
      image?: { base64: string }
      reply_to?: string
      mentions?: string[]
      idempotency_key?: string
    }) => call<SendResult>("POST", "/messages", body),
    me: () => call<{ jid: string | null; lid: string | null }>("GET", "/me"),
    message: (chat: string, id: string) =>
      call<{ chat: Record<string, unknown>; message: Record<string, unknown> }>(
        "GET",
        `/messages/${enc(chat)}/${enc(id)}`,
      ),
    messages: (chat: string, limit: number) =>
      call<{ chat: Record<string, unknown>; messages: Record<string, unknown>[] }>(
        "GET",
        `/chats/${enc(chat)}/messages?limit=${limit}`,
      ),
    chats: (query: string) =>
      call<{ chats: Record<string, unknown>[] }>("GET", `/chats${query ? `?${query}` : ""}`),
    typing: (chat: string) =>
      call<void>("POST", `/chats/${enc(chat)}/presence`, { state: "typing" }),
    webhooks: () => call<{ webhooks: Record<string, unknown>[] }>("GET", "/webhooks"),
    createWebhook: (body: Record<string, unknown>) =>
      call<Record<string, unknown>>("POST", "/webhooks", body),
  }
}

/** True for errors that won't go away by retrying (bad request, not found, not allowed). */
export function permanent(error: unknown): boolean {
  return error instanceof WaError && error.status >= 400 && error.status < 500 && error.status !== 429
}
