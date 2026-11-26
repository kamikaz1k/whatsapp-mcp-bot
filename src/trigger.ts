// Decides whether a WhatsApp message is a request for the bot, and what it asks.
//
// A message counts when:
// - someone in a subscribed chat tags you and the text then starts with the trigger
//   word ("@Ana bot can you…"), or
// - someone in a subscribed chat replies to one of your messages (the bot's replies
//   included) and the text starts with the trigger word, or
// - in a subscribed direct chat, the text starts with the trigger word, or
// - you send it yourself, in any chat, starting with the trigger word.
// Replies start with the reply prefix, never the trigger word, so the bot never
// answers itself.

export interface Person {
  readonly jid: string
  readonly name: string | null
  readonly phone: string | null
}

export interface ChatRef {
  readonly jid: string
  readonly name: string | null
  readonly type: "direct" | "group" | string
}

/** The `message` object of a whatsapp-mcp webhook event (only the fields used here). */
export interface WaMessage {
  readonly id: string
  readonly sent_at: string
  readonly from_me: boolean
  readonly sender: Person | null
  readonly kind: string
  readonly text: string | null
  readonly mentions_me: boolean
  /** The message quotes one of yours. */
  readonly reply_to_me?: boolean
  readonly reply_to: string | null
  readonly transcript?: string | null
}

export interface Subscriptions {
  /** Chat JIDs (or bare phone numbers) where other people may call the bot. */
  readonly chats: readonly string[]
  /** If not empty, only these senders (JIDs or phone numbers) may call the bot. */
  readonly allowedSenders: readonly string[]
}

export interface TriggerOptions {
  readonly word: string
  readonly replyPrefix: string
}

export interface Trigger {
  readonly id: string
  readonly chat: ChatRef
  readonly sender: Person | null
  readonly fromMe: boolean
  readonly sentAt: string
  /** The request with the mention and the trigger word removed. */
  readonly prompt: string
  /** The quoted message the request replies to, if any. */
  readonly replyTo: string | null
}

const LEADING_MENTIONS = /^(?:\s*@[^\s]+[\s,:]*)+/u

function digits(value: string): string {
  return value.replace(/\D/g, "")
}

/** True when `id` (a JID or phone number) is in `list`, comparing JIDs exactly and phones by digits. */
export function listed(list: readonly string[], ...ids: (string | null | undefined)[]): boolean {
  for (const entry of list) {
    const entryDigits = entry.includes("@") ? null : digits(entry)
    for (const id of ids) {
      if (!id) continue
      if (entry === id) return true
      if (entryDigits && entryDigits.length >= 6 && digits(id.split("@")[0] ?? "") === entryDigits) {
        return true
      }
    }
  }
  return false
}

/** The request after the trigger word, or null when the text doesn't start with it. */
export function afterWord(text: string, word: string): string | null {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`^\\s*${escaped}(?![\\p{L}\\p{N}_])[\\s,:;.!-]*`, "iu").exec(text)
  if (!match) return null
  return text.slice(match[0].length).trim()
}

export type Command = "subscribe" | "unsubscribe"

/**
 * `bot subscribe` / `bot unsubscribe`, sent by you in a chat: lets others in that chat
 * call the bot, or stops them. Only your own messages count.
 */
export function detectCommand(message: WaMessage, options: TriggerOptions): Command | null {
  if (!message.from_me) return null
  const rest = afterWord((message.text ?? "").trim(), options.word)
  const command = rest?.toLowerCase().replace(/[.!\s]+$/u, "")
  return command === "subscribe" || command === "unsubscribe" ? command : null
}

export type PromptCommand =
  | { readonly action: "set"; readonly text: string }
  | { readonly action: "show" }
  | { readonly action: "clear" }

/**
 * `bot set prompt <text>`, `bot show prompt` (or `bot prompt`), `bot clear prompt`: this
 * chat's instructions. Only your own messages count. The text keeps its case and lines.
 */
export function detectPromptCommand(message: WaMessage, options: TriggerOptions): PromptCommand | null {
  if (!message.from_me) return null
  const rest = afterWord((message.text ?? "").trim(), options.word)
  if (rest === null) return null
  const set = /^set\s+prompt(?![\p{L}\p{N}_])[\s:]*([\s\S]*)$/iu.exec(rest)
  if (set) return { action: "set", text: set[1]!.trim() }
  const command = rest.toLowerCase().replace(/[.!?\s]+$/u, "")
  if (command === "show prompt" || command === "prompt") return { action: "show" }
  if (command === "clear prompt") return { action: "clear" }
  return null
}

export function detectTrigger(
  chat: ChatRef,
  message: WaMessage,
  subscriptions: Subscriptions,
  options: TriggerOptions,
): Trigger | null {
  const text = (message.text ?? message.transcript ?? "").trim()
  if (!text || text.startsWith(options.replyPrefix)) return null

  let prompt: string | null = null
  if (message.from_me) {
    prompt = afterWord(text, options.word)
  } else {
    if (!listed(subscriptions.chats, chat.jid)) return null
    if (
      subscriptions.allowedSenders.length > 0 &&
      !listed(subscriptions.allowedSenders, message.sender?.jid, message.sender?.phone)
    ) {
      return null
    }
    if (message.mentions_me || message.reply_to_me) {
      prompt = afterWord(text.replace(LEADING_MENTIONS, ""), options.word)
    } else if (chat.type === "direct") {
      prompt = afterWord(text, options.word)
    }
  }
  if (prompt === null) return null

  return {
    id: message.id,
    chat,
    sender: message.sender,
    fromMe: message.from_me,
    sentAt: message.sent_at,
    prompt,
    replyTo: message.reply_to,
  }
}
