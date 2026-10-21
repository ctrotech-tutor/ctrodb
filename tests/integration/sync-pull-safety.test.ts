/**
 * Regression tests for the sync pull path (audit finding C-01 / H-14).
 *
 * Contract under test
 * -------------------
 * 1. A remote change never overwrites a *newer* queued local edit.
 * 2. A remote change wins when it is newer than (or the same age as) the
 *    queued local edit, and the superseded queue entry is drained so the next
 *    push cannot resurrect stale data.
 * 3. Applied remote changes go through Collection: schema validation, change
 *    events, and plugin hooks run exactly as for local writes.
 * 4. Remote writes are not re-queued by the sync plugin.
 * 5. The queue never leaves a change stranded in "syncing".
 * 6. Pulling the same batch twice is idempotent.
 *
 * This file must pass on the memory adapter with **no IndexedDB globals**, so
 * it runs in the Node environment too (see vitest.workspace.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import { inspectSyncQueue } from "../../src/sync/devtools"
import { syncPlugin } from "../../src/sync/sync-plugin"
import type {
  PullOptions,
  PushOptions,
  SyncChangeRecord,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "../../src/sync/types"
import type { ChangeEvent, ID } from "../../src/types"

interface RemoteChange {
  id: string
  collection: string
  recordId: ID
  type: "create" | "update" | "delete"
  data: Record<string, unknown> | null
  timestamp: string
}

class ScriptedTransport implements SyncTransport {
  readonly name = "scripted"
  pushes: SyncChangeRecord[][] = []
  pullCalls = 0
  pages: SyncPullResult[] = []
  /** When false, every pushed change is reported as accepted. */
  accepting = true
  conflict: Omit<SyncPushResult, "accepted" | "errors">["conflicts"] = []

  async push(changes: SyncChangeRecord[], _options?: PushOptions): Promise<SyncPushResult> {
    this.pushes.push(changes)
    if (!this.accepting) {
      return { accepted: [], conflicts: [], errors: [] }
    }
    return {
      accepted: changes.map((c) => ({ id: c.id, serverTimestamp: new Date().toISOString() })),
      conflicts: this.conflict,
      errors: [],
    }
  }

  async pull(_options?: PullOptions): Promise<SyncPullResult> {
    const page = this.pages[this.pullCalls] ?? { changes: [], cursor: null, hasMore: false }
    this.pullCalls++
    return page
  }

  queue(...changes: RemoteChange[]): void {
    this.pages = [{ changes, cursor: changes.at(-1)?.id ?? null, hasMore: false }]
    this.pullCalls = 0
  }
}

const schema = {
  version: 1,
  collections: {
    todos: {
      fields: {
        id: { type: "string" },
        text: { type: "string", required: true },
        done: { type: "boolean", default: false },
        priority: { type: "number" },
      },
    },
  },
}

function now(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

describe("sync pull — remote changes are safe, observable writes", () => {
  let transport: ScriptedTransport
  let db: Database
  let events: ChangeEvent[]

  async function setup(schemaConfig: unknown = schema): Promise<void> {
    transport = new ScriptedTransport()
    db = new Database({
      name: `pull-safety-${Math.random().toString(36).slice(2)}`,
      adapter: "memory",
      schema: schemaConfig as never,
      plugins: [syncPlugin({ transport, autoSync: false })],
    })
    await db.connect()
    events = []
    db.on((event) => events.push(event))
  }

  beforeEach(async () => {
    await setup()
  })

  afterEach(async () => {
    await db.disconnect()
  })

  // ── 1. Stale remote must not clobber a newer local edit ──────────────────

  it("keeps a newer pending local edit when a stale remote update arrives", async () => {
    const todos = db.collection("todos")
    const local = await todos.create({ text: "LOCAL EDIT" })

    // Push fails, so the change stays queued as pending.
    transport.accepting = false
    await db.sync()
    await db.sync() // second attempt, still queued

    const pendingBefore = await inspectSyncQueue(db)
    expect(pendingBefore.stats.pending + pendingBefore.stats.failed).toBeGreaterThan(0)

    // Remote carries the same record but is 60s older than the local edit.
    transport.accepting = true
    transport.queue({
      id: "srv-1",
      collection: "todos",
      recordId: local.id,
      type: "update",
      data: { text: "STALE SERVER VALUE" },
      timestamp: now(-60_000),
    })

    await db.sync()

    const after = await todos.get(local.id)
    expect(after?.text).toBe("LOCAL EDIT")

    // The local edit reached the server (this cycle's push succeeded), so the
    // queue is drained — but the value was never overwritten by the stale
    // remote snapshot.
    const pushedValues = transport.pushes.flat().map((c) => c.data?.text)
    expect(pushedValues).toContain("LOCAL EDIT")

    const queue = await inspectSyncQueue(db)
    expect(queue.stats.syncing).toBe(0)
    expect(queue.pending).toHaveLength(0)
  })

  it("never clobbers a newer local edit, even when only the queue is newer", async () => {
    const todos = db.collection("todos")
    const local = await todos.create({ text: "v2" })
    transport.accepting = false
    await db.sync()

    transport.accepting = true
    transport.queue({
      id: "srv-old",
      collection: "todos",
      recordId: local.id,
      type: "update",
      data: { text: "v1" },
      timestamp: now(-5000),
    })
    await db.sync()

    expect((await todos.get(local.id))?.text).toBe("v2")
  })

  // ── 2. Newer remote wins and the queue is drained ───────────────────────

  it("applies a newer remote change and drains the superseded queue entry", async () => {
    const todos = db.collection("todos")
    const local = await todos.create({ text: "old local" })
    transport.accepting = false
    await db.sync()

    transport.accepting = true
    transport.queue({
      id: "srv-new",
      collection: "todos",
      recordId: local.id,
      type: "update",
      data: { text: "new remote" },
      timestamp: now(60_000),
    })
    await db.sync()

    expect((await todos.get(local.id))?.text).toBe("new remote")

    const queue = await inspectSyncQueue(db)
    expect(queue.pending).toHaveLength(0)
    expect(queue.failed).toHaveLength(0)
  })

  it("gives ties to the remote, matching the LWW conflict resolver", async () => {
    const todos = db.collection("todos")
    const local = await todos.create({ id: "tie-1", text: "local" })
    transport.accepting = false
    await db.sync()

    const queued = await inspectSyncQueue(db)
    const localTimestamp = queued.pending[0]?.timestamp
    expect(localTimestamp).toBeDefined()

    transport.accepting = true
    transport.queue({
      id: "srv-tie",
      collection: "todos",
      recordId: local.id,
      type: "update",
      data: { text: "remote" },
      // Exactly the same instant as the queued local change.
      timestamp: localTimestamp as string,
    })
    await db.sync()

    // Ties go to the remote, exactly like ConflictResolverEngine's LWW.
    expect((await todos.get("tie-1"))?.text).toBe("remote")
  })

  // ── 3. Remote writes are observable ─────────────────────────────────────

  it("emits change events for records created by pull", async () => {
    transport.queue({
      id: "srv-c1",
      collection: "todos",
      recordId: "remote-1",
      type: "create",
      data: { text: "from server" },
      timestamp: now(),
    })

    await db.sync()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "create",
      collection: "todos",
      recordId: "remote-1",
    })
    expect(await db.collection("todos").get("remote-1")).toBeDefined()
  })

  it("emits change events for records updated and deleted by pull", async () => {
    const todos = db.collection("todos")
    await todos.create({ id: "remote-2", text: "before" })
    events.length = 0

    transport.queue(
      {
        id: "srv-u1",
        collection: "todos",
        recordId: "remote-2",
        type: "update",
        data: { text: "after" },
        timestamp: now(1000),
      },
      {
        id: "srv-d1",
        collection: "todos",
        recordId: "remote-2",
        type: "delete",
        data: null,
        timestamp: now(2000),
      },
    )

    await db.sync()

    expect(events.map((e) => e.type)).toEqual(["update", "delete"])
    expect(await todos.get("remote-2")).toBeUndefined()
  })

  // ── 4. Remote writes are not re-queued ──────────────────────────────────

  it("does not queue applied remote changes for push", async () => {
    transport.queue({
      id: "srv-noecho",
      collection: "todos",
      recordId: "remote-3",
      type: "create",
      data: { text: "no echo" },
      timestamp: now(),
    })
    await db.sync()

    const queue = await inspectSyncQueue(db)
    expect(queue.stats.total).toBe(0)
  })

  it("still queues genuine local writes made after a pull", async () => {
    transport.queue({
      id: "srv-4",
      collection: "todos",
      recordId: "remote-4",
      type: "create",
      data: { text: "server" },
      timestamp: now(),
    })
    await db.sync()

    await db.collection("todos").create({ text: "local after pull" })
    const queue = await inspectSyncQueue(db)
    expect(queue.stats.pending).toBe(1)
  })

  // ── 5. No stranded changes ──────────────────────────────────────────────

  it("rolls unacknowledged pushes back to pending instead of stranding them", async () => {
    await db.collection("todos").create({ text: "unacked" })
    transport.accepting = false

    await db.sync()

    const queue = await inspectSyncQueue(db)
    expect(queue.syncing).toHaveLength(0)
    expect(queue.stats.pending).toBe(1)
  })

  // ── 6. Schema validation applies to remote data ─────────────────────────

  it("rejects remote data that violates the schema and reports the failure", async () => {
    transport.queue({
      id: "srv-bad",
      collection: "todos",
      recordId: "remote-bad",
      type: "create",
      data: { text: 42 },
      timestamp: now(),
    })

    const phases: string[] = []
    db.onSync((event) => phases.push(event.phase))

    await db.sync()

    // The invalid record is not stored…
    expect(await db.collection("todos").get("remote-bad")).toBeUndefined()
    // …and the failure is surfaced as a sync error, not silently swallowed.
    expect(phases).toContain("error")
  })

  // ── 7. Idempotency ──────────────────────────────────────────────────────

  it("is idempotent when the same batch is pulled twice", async () => {
    transport.queue({
      id: "srv-idem",
      collection: "todos",
      recordId: "remote-5",
      type: "create",
      data: { text: "once" },
      timestamp: now(),
    })

    await db.sync()
    transport.pullCalls = 0 // replay the page
    await db.sync()

    const rows = await db.collection("todos").getAll()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toBe("once")
  })

  it("keeps a local delete when the remote replay is older", async () => {
    const todos = db.collection("todos")
    const record = await todos.create({ text: "to delete" })
    await todos.delete(record.id)
    transport.accepting = false
    await db.sync()

    transport.accepting = true
    transport.queue({
      id: "srv-replay",
      collection: "todos",
      recordId: record.id,
      type: "update",
      data: { text: "resurrected?" },
      timestamp: now(-60_000),
    })
    await db.sync()

    expect(await todos.get(record.id)).toBeUndefined()
  })
})
