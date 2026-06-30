import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Database } from "../../src/database"
import { SYNC_STORE } from "../../src/sync/change-tracker"
import { SyncEngine } from "../../src/sync/sync-engine"
import { syncPlugin } from "../../src/sync/sync-plugin"
import type {
  SyncChangeRecord,
  SyncPluginConfig,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
  PushOptions,
  PullOptions,
} from "../../src/sync/types"

// ── Mock Transport ──

class MockTransport implements SyncTransport {
  readonly name = "mock"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }
  pushCallCount = 0
  pullCallCount = 0
  pushFail: Error | null = null
  pullFail: Error | null = null
  connected = true

  async push(_changes: SyncChangeRecord[], _options?: PushOptions): Promise<SyncPushResult> {
    this.pushCallCount++
    if (this.pushFail) throw this.pushFail
    return this.pushResult
  }

  async pull(_options?: PullOptions): Promise<SyncPullResult> {
    this.pullCallCount++
    if (this.pullFail) throw this.pullFail
    return this.pullResult
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return this.connected
  }
}

// ── Shared Helpers ──

function createDb(
  transport: SyncTransport,
  config?: Partial<SyncPluginConfig>,
): { db: Database } {
  const plugin = syncPlugin({
    transport,
    strategy: "lww",
    autoSync: false,
    ...config,
  })
  const db = new Database({
    name: "test_sync_flow",
    adapter: "memory",
    schema: {
      version: 1,
      collections: {
        todos: {
          fields: {
            title: { type: "string" },
            done: { type: "boolean" },
            priority: { type: "number" },
          },
        },
        notes: {
          fields: { content: { type: "string" } },
        },
      },
    },
    plugins: [plugin],
  })
  return { db }
}

async function getSyncChanges(db: Database): Promise<SyncChangeRecord[]> {
  const adapter = db._getAdapter()
  return (await adapter.findAll(SYNC_STORE)) as SyncChangeRecord[]
}

describe("Sync Integration Flow", () => {
  let transport: MockTransport
  let db: Database

  beforeEach(async () => {
    transport = new MockTransport()
    const ctx = createDb(transport)
    db = ctx.db
    await db.connect()
  })

  afterEach(async () => {
    if (db) await db.disconnect()
    vi.useRealTimers()
  })

  // ── 1. Sync cycle: create → track → push → commit ──

  describe("create → track → push → commit", () => {
    it("tracks a created record and pushes it on sync", async () => {
      const todos = db.collection("todos")
      const record = await todos.create({ title: "Buy milk", done: false })

      const changes = await getSyncChanges(db)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.type).toBe("create")
      expect(changes[0]!.recordId).toBe(record.id)
      expect(changes[0]!.status).toBe("pending")

      transport.pushResult = {
        accepted: [{ id: changes[0]!.id, serverTimestamp: new Date().toISOString() }],
        conflicts: [],
        errors: [],
      }

      await db.sync()

      const after = await getSyncChanges(db)
      expect(after).toHaveLength(0)
      expect(transport.pushCallCount).toBe(1)
    })

    it("pushes the correct snapshot data", async () => {
      const todos = db.collection("todos")
      let pushed: unknown = null

      transport.push = async (changes) => {
        pushed = changes[0]?.data
        return {
          accepted: [{ id: changes[0]!.id, serverTimestamp: new Date().toISOString() }],
          conflicts: [],
          errors: [],
        }
      }

      await todos.create({ title: "Test", done: false, priority: 1 })
      await db.sync()

      expect(pushed).toMatchObject({ title: "Test", done: false, priority: 1 })
    })
  })

  // ── 2. Sync cycle: update → track → push → commit ──

  describe("update → track → push → commit", () => {
    it("tracks an updated record and pushes it on sync", async () => {
      const todos = db.collection("todos")
      const record = await todos.create({ title: "Old", done: false })

      await todos.update(record.id, { title: "Updated" })

      const changes = await getSyncChanges(db)
      const update = changes.find((c) => c.type === "update")
      expect(update).toBeDefined()
      expect((update!.data as Record<string, unknown>).title).toBe("Updated")
      expect(update!.status).toBe("pending")

      transport.pushResult = {
        accepted: [{ id: update!.id, serverTimestamp: new Date().toISOString() }],
        conflicts: [],
        errors: [],
      }

      await db.sync()

      const after = await getSyncChanges(db)
      expect(after.find((c) => c.id === update!.id)).toBeUndefined()
    })

    it("includes prevData snapshot", async () => {
      const todos = db.collection("todos")
      const record = await todos.create({ title: "Original", done: false })

      await todos.update(record.id, { title: "Changed", done: true })

      const changes = await getSyncChanges(db)
      const update = changes.find((c) => c.type === "update")
      expect(update!.prevData).toMatchObject({ title: "Original", done: false })
    })
  })

  // ── 3. Sync cycle: delete → track → push → commit ──

  describe("delete → track → push → commit", () => {
    it("tracks a deleted record and pushes it on sync", async () => {
      const todos = db.collection("todos")
      const record = await todos.create({ title: "Delete me", done: false })

      await todos.delete(record.id)

      const changes = await getSyncChanges(db)
      const del = changes.find((c) => c.type === "delete")
      expect(del).toBeDefined()
      expect(del!.recordId).toBe(record.id)
      expect(del!.data).toBeNull()
      expect(del!.status).toBe("pending")

      transport.pushResult = {
        accepted: [{ id: del!.id, serverTimestamp: new Date().toISOString() }],
        conflicts: [],
        errors: [],
      }

      await db.sync()

      const after = await getSyncChanges(db)
      expect(after.find((c) => c.id === del!.id)).toBeUndefined()
    })
  })

  // ── 4. Pull: server changes → apply locally ──

  describe("pull — apply remote changes", () => {
    it("applies remote creates locally", async () => {
      transport.pullResult = {
        changes: [
          {
            id: "svr_1",
            collection: "todos",
            recordId: "remote-1",
            type: "create",
            data: { title: "Remote todo", done: true },
            timestamp: new Date().toISOString(),
          },
        ],
        cursor: "svr_1",
        hasMore: false,
      }

      await db.sync()

      const todos = db.collection("todos")
      const all = await todos.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.id).toBe("remote-1")
      expect(all[0]!.title).toBe("Remote todo")
    })

    it("applies remote updates to existing records", async () => {
      const todos = db.collection("todos")
      const record = await todos.create({ title: "Local", done: false })

      transport.pullResult = {
        changes: [
          {
            id: "svr_2",
            collection: "todos",
            recordId: record.id,
            type: "update",
            data: { title: "Remote update", done: true },
            timestamp: new Date().toISOString(),
          },
        ],
        cursor: "svr_2",
        hasMore: false,
      }

      await db.sync()

      const updated = await todos.get(record.id)
      expect(updated!.title).toBe("Remote update")
      expect(updated!.done).toBe(true)
    })

    it("applies remote deletes to existing records", async () => {
      const todos = db.collection("todos")
      const record = await todos.create({ title: "Delete me", done: false })

      transport.pullResult = {
        changes: [
          {
            id: "svr_3",
            collection: "todos",
            recordId: record.id,
            type: "delete",
            data: null,
            timestamp: new Date().toISOString(),
          },
        ],
        cursor: "svr_3",
        hasMore: false,
      }

      await db.sync()

      const all = await todos.getAll()
      expect(all).toHaveLength(0)
    })

    it("creates records on remote update if they don't exist locally", async () => {
      transport.pullResult = {
        changes: [
          {
            id: "svr_4",
            collection: "todos",
            recordId: "ghost",
            type: "update",
            data: { title: "Ghost record", done: true },
            timestamp: new Date().toISOString(),
          },
        ],
        cursor: "svr_4",
        hasMore: false,
      }

      await db.sync()

      const todos = db.collection("todos")
      const all = await todos.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]!.id).toBe("ghost")
    })
  })

  // ── 5. Pull: pagination (hasMore) ──

  describe("pull — pagination", () => {
    it("continues pulling when hasMore is true", async () => {
      const page1 = new Array(5).fill(null).map((_, i) => ({
        id: `svr_p1_${i}`,
        collection: "todos" as const,
        recordId: `page1-${i}`,
        type: "create" as const,
        data: { title: `Page1 #${i}`, done: false },
        timestamp: new Date().toISOString(),
      }))

      const page2 = new Array(3).fill(null).map((_, i) => ({
        id: `svr_p2_${i}`,
        collection: "todos" as const,
        recordId: `page2-${i}`,
        type: "create" as const,
        data: { title: `Page2 #${i}`, done: false },
        timestamp: new Date().toISOString(),
      }))

      let callCount = 0
      transport.pull = async () => {
        callCount++
        if (callCount === 1) {
          return { changes: page1, cursor: "cursor_1", hasMore: true }
        }
        return { changes: page2, cursor: "cursor_2", hasMore: false }
      }

      await db.sync()

      const todos = db.collection("todos")
      const all = await todos.getAll()
      expect(all).toHaveLength(8)
      expect(callCount).toBe(2)
    })
  })

  // ── 6. Push: partial failure ──

  describe("push — partial failure", () => {
    it("marks accepted changes as committed and failed changes as failed", async () => {
      const todos = db.collection("todos")
      const r1 = await todos.create({ title: "Good" })
      const r2 = await todos.create({ title: "Bad" })

      const changes = await getSyncChanges(db)
      const goodId = changes.find((c) => c.recordId === r1.id)!.id
      const badId = changes.find((c) => c.recordId === r2.id)!.id

      transport.pushResult = {
        accepted: [{ id: goodId, serverTimestamp: new Date().toISOString() }],
        conflicts: [],
        errors: [{ id: badId, error: "Validation failed" }],
      }

      await db.sync()

      const after = await getSyncChanges(db)
      const bad = after.find((c) => c.id === badId)!
      expect(after.find((c) => c.id === goodId)).toBeUndefined()
      expect(bad.status).toBe("failed")
      expect(bad.errorMessage).toBe("Validation failed")
    })
  })

  // ── 7. Conflict: auto-resolve with LWW ──

  describe("conflict resolution — LWW", () => {
    it("resolves push conflicts using last-write-wins", async () => {
      const todos = db.collection("todos")
      const record = await todos.create({ title: "Original", done: false })

      const changes = await getSyncChanges(db)
      const changeId = changes[0]!.id

      transport.pushResult = {
        accepted: [],
        conflicts: [
          {
            changeId,
            recordId: record.id,
            collection: "todos",
            local: { title: "Original", done: false },
            remote: { title: "Server version", done: true },
            localTimestamp: new Date(Date.now() - 60000).toISOString(),
            remoteTimestamp: new Date().toISOString(),
            fieldConflicts: ["title", "done"],
          },
        ],
        errors: [],
      }

      await db.sync()

      // Remote is newer → remote wins
      const updated = await todos.get(record.id)
      expect(updated!.title).toBe("Server version")
      expect(updated!.done).toBe(true)

      // Change should be removed (committed and cleaned up)
      const after = await getSyncChanges(db)
      expect(after.find((c) => c.id === changeId)).toBeUndefined()
    })
  })

  // ── 8. Conflict: auto-resolve with client-wins ──

  describe("conflict resolution — client-wins", () => {
    it("resolves conflicts with client data when strategy is client-wins", async () => {
      const ctx = createDb(transport, { strategy: "client-wins" })
      const clientDb = ctx.db
      await clientDb.connect()

      const todos = clientDb.collection("todos")
      const record = await todos.create({ title: "Client", done: false })

      const changes = await getSyncChanges(clientDb)
      const changeId = changes[0]!.id

      transport.pushResult = {
        accepted: [],
        conflicts: [
          {
            changeId,
            recordId: record.id,
            collection: "todos",
            local: { title: "Client", done: false },
            remote: { title: "Server", done: true },
            localTimestamp: new Date().toISOString(),
            remoteTimestamp: new Date(Date.now() - 60000).toISOString(),
            fieldConflicts: ["title", "done"],
          },
        ],
        errors: [],
      }

      await clientDb.sync()

      // Client wins → local data kept
      const updated = await todos.get(record.id)
      expect(updated!.title).toBe("Client")
      expect(updated!.done).toBe(false)

      await clientDb.disconnect()
    })
  })

  // ── 9. Auto-sync: changes pushed on timer ──

  describe("auto-sync — timer", () => {
    it("automatically syncs at the configured interval", async () => {
      const plugin = syncPlugin({
        transport,
        strategy: "lww",
        autoSync: { intervalMs: 50 },
      })
      const autoDb = new Database({
        name: "test_auto_sync",
        adapter: "memory",
        schema: {
          version: 1,
          collections: {
            todos: {
              fields: { title: { type: "string" }, done: { type: "boolean" } },
            },
          },
        },
        plugins: [plugin],
      })

      // Spy on the engine's sync method directly
      const syncSpy = vi.spyOn(SyncEngine.prototype, "sync")

      await autoDb.connect()

      await new Promise((r) => setTimeout(r, 120))

      expect(syncSpy).toHaveBeenCalled()

      syncSpy.mockRestore()
      await autoDb.disconnect()
    })
  })

  // ── 10. Auto-sync: debounce rapid changes ──

  describe("auto-sync — debounce", () => {
    it("debounces rapid triggerSync calls into a single sync", async () => {
      // Debounce is relevant for cross-tab scenarios where triggerSync() is called.
      // We test it here through the SyncEngine's triggerSync() API.
      const engine = new SyncEngine(db, {
        transport,
        autoSync: { debounceMs: 50 },
      })

      const syncSpy = vi.spyOn(engine, "sync")

      await engine.init()

      engine.triggerSync()
      engine.triggerSync()
      engine.triggerSync()

      expect(syncSpy).not.toHaveBeenCalled()

      await new Promise((r) => setTimeout(r, 100))

      expect(syncSpy).toHaveBeenCalledTimes(1)

      syncSpy.mockRestore()
      await engine.destroy()
    })
  })

  // ── 11. Offline: changes queue until reconnect ──

  describe("offline — queue until reconnect", () => {
    it("queues changes when transport fails and retries after recovery", async () => {
      const todos = db.collection("todos")
      await todos.create({ title: "Offline create", done: false })

      // Make transport fail on push
      transport.pushFail = new Error("Network unavailable")

      // Sync attempt fails
      await db.sync()

      // Changes should remain pending (not committed, not syncing since failed)
      // Actually the push threw, so the engine marks them back to pending
      const changes = await getSyncChanges(db)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.status).toBe("pending")

      // Now reconnect — clear the error
      transport.pushFail = null
      transport.pushResult = {
        accepted: [{ id: changes[0]!.id, serverTimestamp: new Date().toISOString() }],
        conflicts: [],
        errors: [],
      }

      await db.sync()

      expect(transport.pushCallCount).toBe(2)
      const after = await getSyncChanges(db)
      expect(after).toHaveLength(0)
    })
  })

  // ── 12. Backoff: retry delay increases ──

  describe("backoff — retry on failure", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it("retries after failure with increasing delay", async () => {
      const ctx = createDb(transport, { autoSync: true })
      const retryDb = ctx.db
      await retryDb.connect()

      const todos = retryDb.collection("todos")
      await todos.create({ title: "Retry me", done: false })

      // First sync fails
      transport.pushFail = new Error("Network error")
      await retryDb.sync()
      expect(transport.pushCallCount).toBe(1)

      // Backoff should trigger retry after ~1s (with jitter)
      transport.pushFail = null
      transport.pushResult = {
        accepted: [
          {
            id: (await getSyncChanges(retryDb))[0]!.id,
            serverTimestamp: new Date().toISOString(),
          },
        ],
        conflicts: [],
        errors: [],
      }

      // Advance past backoff (initial 1s * 1.25 max jitter ≈ 1250ms)
      await vi.advanceTimersByTimeAsync(1500)

      expect(transport.pushCallCount).toBeGreaterThanOrEqual(2)

      await retryDb.disconnect()
    })
  })

  // ── 13. Multi-collection sync ──

  describe("multi-collection sync", () => {
    it("syncs changes from multiple collections", async () => {
      const todos = db.collection("todos")
      const notes = db.collection("notes")

      await todos.create({ title: "Todo 1", done: false })
      await notes.create({ content: "Note 1" })

      let allPushed: SyncChangeRecord[] = []
      transport.push = async (changes) => {
        allPushed = changes
        return {
          accepted: changes.map((c) => ({ id: c.id, serverTimestamp: new Date().toISOString() })),
          conflicts: [],
          errors: [],
        }
      }

      await db.sync()

      expect(allPushed).toHaveLength(2)
      const collections = allPushed.map((c) => c.collection).sort()
      expect(collections).toEqual(["notes", "todos"])
    })
  })
})
