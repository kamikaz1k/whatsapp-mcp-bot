// Which chats others may call the bot from, in D1. KV caches reads for up to 60 s, so
// "bot subscribe" followed by "bot unsubscribe" could lose one; D1 reads are current.
import { type Command, listed, type Subscriptions } from "./trigger"

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS subscribed_chats (chat TEXT PRIMARY KEY, added_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS allowed_senders (sender TEXT PRIMARY KEY)",
]

async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA.map((statement) => db.prepare(statement)))
}

export async function loadSubscriptions(db: D1Database): Promise<Subscriptions> {
  await ensureSchema(db)
  const [chats, senders] = await db.batch<{ chat?: string; sender?: string }>([
    db.prepare("SELECT chat FROM subscribed_chats ORDER BY added_at"),
    db.prepare("SELECT sender FROM allowed_senders ORDER BY sender"),
  ])
  return {
    chats: chats!.results.map((row) => row.chat!),
    allowedSenders: senders!.results.map((row) => row.sender!),
  }
}

/** Replaces both lists in one transaction. */
export async function saveSubscriptions(db: D1Database, subscriptions: Subscriptions, now: number): Promise<void> {
  await ensureSchema(db)
  const at = new Date(now).toISOString()
  await db.batch([
    db.prepare("DELETE FROM subscribed_chats"),
    db.prepare("DELETE FROM allowed_senders"),
    ...subscriptions.chats.map((chat, i) =>
      db.prepare("INSERT OR IGNORE INTO subscribed_chats (chat, added_at) VALUES (?, ?)").bind(chat, `${at}#${String(i).padStart(4, "0")}`),
    ),
    ...subscriptions.allowedSenders.map((sender) =>
      db.prepare("INSERT OR IGNORE INTO allowed_senders (sender) VALUES (?)").bind(sender),
    ),
  ])
}

/**
 * Adds or removes one chat. Repeating it changes nothing, so webhook retries are safe.
 * Removing also drops an entry written as a phone number for the same chat.
 */
export async function changeSubscription(db: D1Database, chat: string, command: Command, now: number): Promise<Subscriptions> {
  await ensureSchema(db)
  if (command === "subscribe") {
    await db
      .prepare("INSERT OR IGNORE INTO subscribed_chats (chat, added_at) VALUES (?, ?)")
      .bind(chat, new Date(now).toISOString())
      .run()
  } else {
    const { chats } = await loadSubscriptions(db)
    const gone = chats.filter((entry) => listed([entry], chat))
    if (gone.length > 0) {
      await db.batch(gone.map((entry) => db.prepare("DELETE FROM subscribed_chats WHERE chat = ?").bind(entry)))
    }
  }
  return loadSubscriptions(db)
}
