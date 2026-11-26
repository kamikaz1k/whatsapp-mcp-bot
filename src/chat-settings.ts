// Per-chat instructions (a personality, or how to act in given situations), in D1.
// Only the owner changes them: by command, through the owner-only tool, or the API.

/** Longest instructions text kept for one chat. */
export const MAX_CHAT_INSTRUCTIONS = 2000

const SCHEMA = `CREATE TABLE IF NOT EXISTS chat_settings (
  chat TEXT PRIMARY KEY,
  instructions TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

async function ensureSchema(db: D1Database): Promise<void> {
  await db.prepare(SCHEMA).run()
}

export async function getChatInstructions(db: D1Database, chat: string): Promise<string | null> {
  await ensureSchema(db)
  const row = await db.prepare("SELECT instructions FROM chat_settings WHERE chat = ?").bind(chat).first<{ instructions: string }>()
  return row?.instructions ?? null
}

export type SaveResult = { readonly ok: true; readonly instructions: string | null } | { readonly ok: false; readonly error: string }

/** Replaces a chat's instructions; empty text clears them. Repeating it changes nothing. */
export async function setChatInstructions(db: D1Database, chat: string, text: string | null, now: number): Promise<SaveResult> {
  await ensureSchema(db)
  const instructions = (text ?? "").trim()
  if (instructions.length > MAX_CHAT_INSTRUCTIONS) {
    return { ok: false, error: `too long: ${instructions.length} characters, ${MAX_CHAT_INSTRUCTIONS} at most` }
  }
  if (!instructions) {
    await db.prepare("DELETE FROM chat_settings WHERE chat = ?").bind(chat).run()
    return { ok: true, instructions: null }
  }
  await db
    .prepare(
      `INSERT INTO chat_settings (chat, instructions, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (chat) DO UPDATE SET instructions = excluded.instructions, updated_at = excluded.updated_at`,
    )
    .bind(chat, instructions, new Date(now).toISOString())
    .run()
  return { ok: true, instructions }
}
