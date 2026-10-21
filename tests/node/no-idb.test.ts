/**
 * Runs in a **pure Node environment with no IndexedDB globals**.
 *
 * This project exists because `tests/setup.ts` installs `fake-indexeddb/auto`,
 * which defines `IDBKeyRange` for every other test and therefore hid the fact
 * that indexed queries and the sync engine used to throw
 * `ReferenceError: IDBKeyRange is not defined` on Node (audit findings H-01,
 * H-02). These assertions fail loudly if a browser global leaks back into the
 * core.
 */
import { describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import { syncPlugin } from "../../src/sync/sync-plugin"
import type { SyncPullResult, SyncPushResult, SyncTransport } from "../../src/sync/types"
import type { SchemaConfig } from "../../src/types"

const schema: SchemaConfig = {
  version: 1,
  collections: {
    tasks: {
      fields: {
        title: { type: "string" },
        done: { type: "boolean" },
        priority: { type: "number" },
      },
      indexes: [{ field: "priority" }, { field: "done" }],
    },
  },
}

const transport: SyncTransport = {
  name: "noop",
  async push(): Promise<SyncPushResult> {
    return { accepted: [], conflicts: [], errors: [] }
  },
  async pull(): Promise<SyncPullResult> {
    return { changes: [], cursor: null, hasMore: false }
  },
}

describe("Node without IndexedDB", () => {
  it("has no browser storage globals", () => {
    expect(typeof indexedDB).toBe("undefined")
    expect(typeof IDBKeyRange).toBe("undefined")
  })

  it("runs indexed queries on the memory adapter", async () => {
    const db = new Database({ name: "node-indexed", adapter: "memory", schema })
    await db.connect()
    const tasks = db.collection("tasks")
    await tasks.create({ title: "a", done: false, priority: 3 })
    await tasks.create({ title: "b", done: true, priority: 1 })
    await tasks.create({ title: "c", done: true, priority: 2 })

    const byEquality = await tasks.query().where("priority", "==", 2).fetch()
    expect(byEquality.map((t) => t.title)).toEqual(["c"])

    const byRange = await tasks.query().where("priority", ">", 1).fetch()
    expect(byRange.map((t) => t.title).sort()).toEqual(["a", "c"])

    const byNotEqual = await tasks.query().where("priority", "!=", 1).fetch()
    expect(byNotEqual.map((t) => t.title).sort()).toEqual(["a", "c"])

    await db.disconnect()
  })

  it("connects and completes a sync cycle with the sync plugin", async () => {
    const db = new Database({
      name: "node-sync",
      adapter: "memory",
      schema,
      plugins: [syncPlugin({ transport, autoSync: false })],
    })
    await db.connect()
    await db.collection("tasks").create({ title: "queued", priority: 1 })

    await expect(db.sync()).resolves.toBeUndefined()

    // Nothing was acknowledged, so the change rolls back to pending rather
    // than being stranded in "syncing".
    const status = db.syncStatus
    expect(status.lastError).toBeNull()
    expect(await db.getPendingCount()).toBe(1)

    await db.disconnect()
  })

  it("supports inspectSyncQueue and devtools without browser globals", async () => {
    const { inspectSyncQueue, retryFailedSync } = await import("../../src/sync/devtools")
    const db = new Database({
      name: "node-devtools",
      adapter: "memory",
      schema,
      plugins: [syncPlugin({ transport, autoSync: false })],
    })
    await db.connect()
    await db.collection("tasks").create({ title: "queued", priority: 1 })

    const snapshot = await inspectSyncQueue(db)
    expect(snapshot.stats.pending).toBe(1)
    await expect(retryFailedSync(db)).resolves.toBe(0)

    await db.disconnect()
  })
})
