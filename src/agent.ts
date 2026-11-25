// One ChatAgent per WhatsApp chat. It is the only place that decides what runs next in
// that chat, so requests are answered one batch at a time, in order:
//
// 1. `enqueue` stores the trigger (once per message id) and queues the 👀 reaction.
// 2. `startNext` starts one ReplyWorkflow for everything pending, if none is running.
// 3. The workflow reports back: done → start the next batch; failed → ❌ on each trigger.
//
// Everything lives in the agent's SQLite and its queue/schedules, so a redeploy at any
// point resumes: the workflow itself is durable, and `sweep` catches a lost callback.
import { Agent } from "agents"

import type { Env } from "./env"
import type { Trigger } from "./trigger"
import { permanent, wa } from "./wa"

export interface ReplyParams {
  readonly chatJid: string
  readonly chatName: string
  readonly triggers: readonly Trigger[]
}

interface Row {
  id: string
  body: string
  status: string
  workflow_id: string | null
  created_at: number
  [key: string]: string | number | null
}

const BATCH_LIMIT = 10
/** A batch older than this is given up on even if its workflow still claims to run. */
const STUCK_MS = 30 * 60 * 1000
const KEEP_DONE_MS = 7 * 24 * 60 * 60 * 1000
const FINISHED = new Set(["complete", "errored", "terminated"])

/** A workflow instance id: letters, digits, - and _, at most 100 characters. */
export function workflowId(triggerId: string): string {
  return `reply-${triggerId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`
}

export class ChatAgent extends Agent<Env> {
  async onStart(): Promise<void> {
    this.sql`CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      workflow_id TEXT,
      created_at INTEGER NOT NULL
    )`
    await this.scheduleEvery(300, "sweep")
  }

  /** Stores a trigger and gets it answered. False when this message was already seen. */
  async enqueue(trigger: Trigger): Promise<boolean> {
    const seen = this.sql<Row>`SELECT id FROM triggers WHERE id = ${trigger.id}`
    if (seen.length > 0) return false
    this.sql`INSERT INTO triggers (id, body, created_at)
      VALUES (${trigger.id}, ${JSON.stringify(trigger)}, ${Date.now()})`
    await this.queue("react", { chat: trigger.chat.jid, id: trigger.id, emoji: this.env.ACK_EMOJI })
    await this.startNext()
    return true
  }

  /** Queue callback: sets this account's reaction on a message. */
  async react(payload: { chat: string; id: string; emoji: string }): Promise<void> {
    try {
      await wa(this.env).react(payload.chat, payload.id, payload.emoji)
    } catch (error) {
      // A message that can't take a reaction (deleted, too old) shouldn't block the queue.
      if (permanent(error)) {
        console.warn("reaction refused", payload, String(error))
        return
      }
      throw error
    }
  }

  async startNext(): Promise<void> {
    const running = this.sql<Row>`SELECT id FROM triggers WHERE status = 'running' LIMIT 1`
    if (running.length > 0) return
    const pending = this.sql<Row>`SELECT * FROM triggers WHERE status = 'pending'
      ORDER BY created_at LIMIT ${BATCH_LIMIT}`
    if (pending.length === 0) return

    const triggers = pending.map((row) => JSON.parse(row.body) as Trigger)
    const id = workflowId(triggers[0]!.id)
    // Marked before the await, so a second call landing meanwhile sees it running.
    for (const row of pending) {
      this.sql`UPDATE triggers SET status = 'running', workflow_id = ${id} WHERE id = ${row.id}`
    }
    const params: ReplyParams = {
      chatJid: triggers[0]!.chat.jid,
      chatName: triggers[0]!.chat.name ?? triggers[0]!.chat.jid,
      triggers,
    }
    try {
      await this.runWorkflow("REPLY_WORKFLOW", params, { id, metadata: { chat: params.chatJid } })
    } catch (error) {
      // Already created (a retry after a lost reply): the running instance carries on.
      if (/already exists/i.test(String(error))) return
      for (const row of pending) {
        this.sql`UPDATE triggers SET status = 'pending', workflow_id = NULL WHERE id = ${row.id}`
      }
      throw error
    }
  }

  async onWorkflowComplete(_name: string, id: string): Promise<void> {
    this.sql`UPDATE triggers SET status = 'done' WHERE workflow_id = ${id} AND status = 'running'`
    await this.startNext()
  }

  async onWorkflowError(_name: string, id: string, error: string): Promise<void> {
    console.error("reply workflow failed", id, error)
    await this.fail(id)
    await this.startNext()
  }

  private async fail(id: string): Promise<void> {
    const rows = this.sql<Row>`SELECT * FROM triggers WHERE workflow_id = ${id} AND status = 'running'`
    this.sql`UPDATE triggers SET status = 'failed' WHERE workflow_id = ${id} AND status = 'running'`
    for (const row of rows) {
      const trigger = JSON.parse(row.body) as Trigger
      await this.queue("react", { chat: trigger.chat.jid, id: trigger.id, emoji: this.env.FAIL_EMOJI })
    }
  }

  /** Schedule callback: settles batches whose workflow callback never arrived. */
  async sweep(): Promise<void> {
    const running = this.sql<Row>`SELECT workflow_id, MIN(created_at) AS created_at FROM triggers
      WHERE status = 'running' GROUP BY workflow_id`
    for (const row of running) {
      const id = row.workflow_id
      if (!id) continue
      let status = "unknown"
      try {
        status = (await (await this.env.REPLY_WORKFLOW.get(id)).status()).status
      } catch (error) {
        console.warn("workflow status unavailable", id, String(error))
      }
      if (status === "complete") {
        await this.onWorkflowComplete("REPLY_WORKFLOW", id)
      } else if (FINISHED.has(status) || Date.now() - row.created_at > STUCK_MS) {
        if (!FINISHED.has(status)) {
          // Stop it so it can't reply after the ❌.
          await this.env.REPLY_WORKFLOW.get(id)
            .then((instance) => instance.terminate())
            .catch((error) => console.warn("terminate failed", id, String(error)))
        }
        await this.fail(id)
      }
    }
    this.sql`DELETE FROM triggers WHERE status IN ('done', 'failed')
      AND created_at < ${Date.now() - KEEP_DONE_MS}`
    await this.startNext()
  }
}
