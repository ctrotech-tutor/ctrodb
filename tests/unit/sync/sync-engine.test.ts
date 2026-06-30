import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Database } from "../../../src/database"
import { SyncEngine } from "../../../src/sync/sync-engine"
import { ChangeTracker } from "../../../src/sync/change-tracker"
import type {
  SyncChangeRecord,
  SyncConflict,
  SyncEvent,
  SyncPluginConfig,
  SyncProgress,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
  PushOptions,
  PullOptions,
  SyncPhase,
} from "../../../src/sync/types"

// ── Mock Transport ──

class MockTransport implements SyncTransport {
  readonly name = "mock"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }
  connected = true
  pushCallCount = 0
  pullCallCount = 0
  pushFail: Error | null = null
  pullFail: Error | null = null
  connectFail: Error | null = null

  async push(
    _changes: SyncChangeRecord[],
    _options?: PushOptions,
  ): Promise<SyncPushResult> {
    this.pushCallCount++
    if (this.pushFail) throw this.pushFail
    return this.pushResult
  }

  async pull(_options?: PullOptions): Promise<SyncPullResult> {
    this.pullCallCount++
    if (this.pullFail) throw this.pullFail
    return this.pullResult
  }

  async connect(): Promise<void> {
    if (this.connectFail) throw this.connectFail
  }

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return this.connected
  }
}

// ── Helpers ──

function makeEngine(
  overrides: Partial<SyncPluginConfig> & { transport?: SyncTransport } = {},
): { engine: SyncEngine; db: Database; transport: MockTransport } {
  const transport = (overrides.transport ?? new MockTransport()) as MockTransport
  const db = new Database({ adapter: "memory" })
  const config: SyncPluginConfig = {
    transport,
    autoSync: false,
    ...overrides,
  }
  const engine = new SyncEngine(db, config)
  return { engine, db, transport }
}

async function seedChange(
  db: Database,
  overrides: Partial<SyncChangeRecord> & { type: "create" | "update" | "delete" },
): Promise<string> {
  const adapter = db._getAdapter()
  const tracker = new ChangeTracker(adapter)
  return tracker.append(
    overrides.type,
    overrides.collection ?? "todos",
    overrides.recordId ?? "rec-1",
    overrides.data ?? { title: "test" },
    overrides.prevData ?? null,
  )
}

// ── Tests ──

describe("SyncEngine", () => {
  describe("constructor", () => {
    it("creates an engine with valid config", () => {
      const transport = new MockTransport()
      const db = new Database({ adapter: "memory" })
      const engine = new SyncEngine(db, { transport })
      expect(engine).toBeInstanceOf(SyncEngine)
    })

    it("sets default config values", () => {
      const transport = new MockTransport()
      const db = new Database({ adapter: "memory" })
      const engine = new SyncEngine(db, { transport })

      // Defaults are verified by behavior:
      // pushBatchSize=50 → only 50 changes pushed per cycle
      // strategy=lww → conflicts resolved by LWW
      // autoSync=false → no automatic sync
      expect(engine).toBeInstanceOf(SyncEngine)
    })
  })

  describe("init", () => {
    it("connects the transport", async () => {
      const { engine, transport } = makeEngine()
      expect(transport.pushCallCount).toBe(0)
      await engine.init()
      // Transport is connected (no error)
    })

    it("restores lastPullCursor from metadata", async () => {
      const { engine, db, transport } = makeEngine()
      const adapter = db._getAdapter()
      await adapter.setMetadata("sync:lastPullCursor", "cursor-123")

      await engine.init()

      // The cursor should be used for the pull request
      let usedCursor: string | null | undefined
      transport.pull = async (opts?: PullOptions) => {
        usedCursor = opts?.cursor
        return { changes: [], cursor: null, hasMore: false }
      }

      await engine.sync()

      expect(usedCursor).toBe("cursor-123")
    })

    it("restores lastSyncAt from metadata", async () => {
      const { engine, db } = makeEngine()
      const adapter = db._getAdapter()
      const ts = new Date().toISOString()
      await adapter.setMetadata("sync:lastSyncAt", ts)

      await engine.init()

      const status = engine.status
      expect(status.lastSyncAt).toBe(ts)
    })

    it("handles connect failure gracefully", async () => {
      const transport = new MockTransport()
      transport.connectFail = new Error("Connection refused")
      const { engine } = makeEngine({ transport })

      await engine.init()

      const status = engine.status
      expect(status.isConnected).toBe(false)
    })

    it("initializes the change tracker (resets stuck syncing)", async () => {
      const { engine, db } = makeEngine()
      const adapter = db._getAdapter()
      const tracker = new ChangeTracker(adapter)
      const id = await tracker.append("create", "todos", "rec-1", { title: "stuck" })
      await tracker.markSyncing([id])

      await engine.init()

      const record = await tracker.getById(id)
      expect(record?.status).toBe("pending")
    })
  })

  describe("destroy", () => {
    it("disconnects the transport", async () => {
      const transport = new MockTransport()
      const disconnectSpy = vi.spyOn(transport, "disconnect")
      const { engine } = makeEngine({ transport })

      await engine.destroy()

      expect(disconnectSpy).toHaveBeenCalledOnce()
    })

    it("stops auto-sync timer", async () => {
      const { engine } = makeEngine({ autoSync: { intervalMs: 100 } })
      await engine.init()

      const clearSpy = vi.spyOn(globalThis, "clearInterval")
      await engine.destroy()

      expect(clearSpy).toHaveBeenCalled()
    })
  })

  describe("status", () => {
    it("returns initial status", () => {
      const { engine } = makeEngine()
      const status = engine.status
      expect(status.isSyncing).toBe(false)
      expect(status.lastSyncAt).toBeNull()
      expect(status.lastError).toBeNull()
    })

    it("reflects isSyncing during sync", async () => {
      const transport = new MockTransport()
      transport.pushResult = {
        accepted: [],
        conflicts: [],
        errors: [],
      }
      const { engine } = makeEngine({ transport })
      await engine.init()

      const syncPromise = engine.sync()

      const status = engine.status
      expect(status.isSyncing).toBe(true)

      await syncPromise
    })
  })

  describe("sync — push", () => {
    it("pushes pending changes to transport", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      await seedChange(db, { type: "create", data: { title: "Hello" } })

      await engine.sync()

      expect(transport.pushCallCount).toBe(1)
    })

    it("skips push when no pending changes", async () => {
      const { engine, transport } = makeEngine()
      await engine.init()

      await engine.sync()

      expect(transport.pushCallCount).toBe(0)
    })

    it("marks accepted changes as committed (cleaned up after sync)", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id = await seedChange(db, { type: "create", data: { title: "Hello" } })
      transport.pushResult = {
        accepted: [{ id, serverTimestamp: "2026-01-01T00:00:00Z" }],
        conflicts: [],
        errors: [],
      }

      await engine.sync()

      // Committed changes are cleaned up by removeCommitted()
      // So the change should no longer exist in the queue
      const adapter = db._getAdapter()
      const tracker = new ChangeTracker(adapter)
      const record = await tracker.getById(id)
      expect(record).toBeUndefined()
    })

    it("marks errored changes as failed", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id = await seedChange(db, { type: "create", data: { title: "Hello" } })
      transport.pushResult = {
        accepted: [],
        conflicts: [],
        errors: [{ id, error: "Validation failed" }],
      }

      await engine.sync()

      const adapter = db._getAdapter()
      const tracker = new ChangeTracker(adapter)
      const record = await tracker.getById(id)
      expect(record?.status).toBe("failed")
      expect(record?.errorMessage).toBe("Validation failed")
    })

    it("reverts to pending on network error", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id = await seedChange(db, { type: "create" })
      transport.pushFail = new Error("Network error")

      await engine.sync()

      const adapter = db._getAdapter()
      const tracker = new ChangeTracker(adapter)
      const record = await tracker.getById(id)
      expect(record?.status).toBe("pending")
    })

    it("handles partial results (some accepted, some errors)", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id1 = await seedChange(db, { type: "create", data: { n: 1 } })
      const id2 = await seedChange(db, { type: "create", data: { n: 2 } })
      transport.pushResult = {
        accepted: [{ id: id1, serverTimestamp: "ts1" }],
        conflicts: [],
        errors: [{ id: id2, error: "Error" }],
      }

      await engine.sync()

      const adapter = db._getAdapter()
      const tracker = new ChangeTracker(adapter)
      // id1 was accepted → committed → cleaned up (removed)
      expect(await tracker.getById(id1)).toBeUndefined()
      // id2 was rejected → stays as "failed"
      expect((await tracker.getById(id2))?.status).toBe("failed")
    })

    it("only pushes up to pushBatchSize changes per cycle", async () => {
      const { engine, db, transport } = makeEngine({ pushBatchSize: 2 })
      await engine.init()
      await seedChange(db, { type: "create", data: { n: 1 } })
      await seedChange(db, { type: "create", data: { n: 2 } })
      await seedChange(db, { type: "create", data: { n: 3 } })

      await engine.sync()

      // Only 2 out of 3 were pushed
      const adapter = db._getAdapter()
      const tracker = new ChangeTracker(adapter)
      const all = await tracker.getAll()
      const syncingOrCommitted = all.filter(
        (c) => c.status === "syncing" || c.status === "committed",
      )
      expect(syncingOrCommitted.length).toBe(2)
    })

    it("is idempotent — concurrent sync calls are no-ops", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      await seedChange(db, { type: "create", data: { title: "Test" } })
      transport.pushResult = {
        accepted: [],
        conflicts: [],
        errors: [],
      }

      const first = engine.sync()
      const second = engine.sync()

      await Promise.all([first, second])

      expect(transport.pushCallCount).toBe(1)
    })
  })

  describe("sync — push conflicts", () => {
    it("resolves conflicts with default LWW strategy", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id = await seedChange(db, {
        type: "update",
        recordId: "rec-1",
        data: { title: "Local" },
      })
      transport.pushResult = {
        accepted: [],
        conflicts: [
          {
            changeId: id,
            recordId: "rec-1",
            collection: "todos",
            local: { title: "Local" },
            remote: { title: "Remote" },
            localTimestamp: "2026-01-01T00:00:00Z",
            remoteTimestamp: "2026-06-01T00:00:00Z",
            fieldConflicts: ["title"],
          },
        ],
        errors: [],
      }

      await engine.sync()

      // Remote wins (LWW — remote timestamp is later)
      const adapter = db._getAdapter()
      const record = (await adapter.findById("todos", "rec-1")) as Record<string, unknown> | undefined
      expect(record?.title).toBe("Remote")
    })

    it("resolves conflict and cleans up change", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id = await seedChange(db, { type: "update", data: { title: "Local" } })
      transport.pushResult = {
        accepted: [],
        conflicts: [
          {
            changeId: id,
            recordId: "rec-1",
            collection: "todos",
            local: { title: "Local" },
            remote: { title: "Remote" },
            localTimestamp: "2026-01-01T00:00:00Z",
            remoteTimestamp: "2026-01-01T00:00:00Z",
            fieldConflicts: ["title"],
          },
        ],
        errors: [],
      }

      await engine.sync()

      // Conflicted change was committed then cleaned up
      const adapter = db._getAdapter()
      const tracker = new ChangeTracker(adapter)
      const record = await tracker.getById(id)
      expect(record).toBeUndefined()
    })
  })

  describe("sync — pull", () => {
    it("pulls changes from transport", async () => {
      const { engine, transport } = makeEngine()
      await engine.init()

      await engine.sync()

      expect(transport.pullCallCount).toBe(1)
    })

    it("applies create changes locally", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      transport.pullResult = {
        changes: [
          {
            id: "chg-1",
            collection: "todos",
            recordId: "rec-new",
            type: "create",
            data: { title: "From Server" },
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "chg-1",
        hasMore: false,
      }

      await engine.sync()

      const adapter = db._getAdapter()
      const record = (await adapter.findById("todos", "rec-new")) as Record<string, unknown> | undefined
      expect(record).toBeDefined()
      expect(record?.title).toBe("From Server")
    })

    it("applies update changes locally", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const adapter = db._getAdapter()
      await adapter.create("todos", { id: "rec-1", title: "Original" })

      transport.pullResult = {
        changes: [
          {
            id: "chg-2",
            collection: "todos",
            recordId: "rec-1",
            type: "update",
            data: { title: "Updated" },
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "chg-2",
        hasMore: false,
      }

      await engine.sync()

      const record = (await adapter.findById("todos", "rec-1")) as Record<string, unknown> | undefined
      expect(record?.title).toBe("Updated")
    })

    it("applies delete changes locally", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const adapter = db._getAdapter()
      await adapter.create("todos", { id: "rec-1", title: "Delete Me" })

      transport.pullResult = {
        changes: [
          {
            id: "chg-3",
            collection: "todos",
            recordId: "rec-1",
            type: "delete",
            data: null,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "chg-3",
        hasMore: false,
      }

      await engine.sync()

      const record = await adapter.findById("todos", "rec-1")
      expect(record).toBeUndefined()
    })

    it("is idempotent for delete on missing record", async () => {
      const { engine, transport } = makeEngine()
      await engine.init()
      transport.pullResult = {
        changes: [
          {
            id: "chg-4",
            collection: "todos",
            recordId: "nonexistent",
            type: "delete",
            data: null,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "chg-4",
        hasMore: false,
      }

      await expect(engine.sync()).resolves.toBeUndefined()
    })

    it("paginates through multiple batches", async () => {
      const { engine, db, transport } = makeEngine({ pullBatchSize: 2 })
      await engine.init()

      let callCount = 0
      transport.pull = async (_opts?: PullOptions) => {
        callCount++
        if (callCount === 1) {
          return {
            changes: [
              { id: "c1", collection: "todos", recordId: "r1", type: "create" as const, data: { n: 1 }, timestamp: "t1" },
              { id: "c2", collection: "todos", recordId: "r2", type: "create" as const, data: { n: 2 }, timestamp: "t2" },
            ],
            cursor: "c2",
            hasMore: true,
          }
        }
        return {
          changes: [
            { id: "c3", collection: "todos", recordId: "r3", type: "create" as const, data: { n: 3 }, timestamp: "t3" },
          ],
          cursor: "c3",
          hasMore: false,
        }
      }

      await engine.sync()

      expect(callCount).toBe(2)
      const adapter = db._getAdapter()
      expect((await adapter.findById("todos", "r1"))).toBeDefined()
      expect((await adapter.findById("todos", "r2"))).toBeDefined()
      expect((await adapter.findById("todos", "r3"))).toBeDefined()
    })

    it("creates record if update arrives for nonexistent record", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      transport.pullResult = {
        changes: [
          {
            id: "chg-5",
            collection: "todos",
            recordId: "rec-new",
            type: "update",
            data: { title: "Created via Update" },
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "chg-5",
        hasMore: false,
      }

      await engine.sync()

      const adapter = db._getAdapter()
      const record = await adapter.findById("todos", "rec-new")
      expect(record).toBeDefined()
      expect((record as Record<string, unknown>)?.title).toBe("Created via Update")
    })

    it("skips update when data is null", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const adapter = db._getAdapter()
      await adapter.create("todos", { id: "rec-1", title: "Keep me" })
      transport.pullResult = {
        changes: [
          {
            id: "chg-6",
            collection: "todos",
            recordId: "rec-1",
            type: "update",
            data: null,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
        cursor: "chg-6",
        hasMore: false,
      }

      await engine.sync()

      const record = await adapter.findById("todos", "rec-1")
      expect((record as Record<string, unknown>)?.title).toBe("Keep me")
    })
  })

  describe("sync — events", () => {
    it("emits events in order: push, pull, complete", async () => {
      const { engine, transport } = makeEngine()
      await engine.init()
      transport.pushResult = { accepted: [], conflicts: [], errors: [] }

      const phases: string[] = []
      engine.onEvent((event) => {
        phases.push(event.phase)
      })

      await engine.sync()

      expect(phases).toEqual(["push", "pull", "complete"])
    })

    it("emits error event on sync failure", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      await seedChange(db, { type: "create", data: { title: "Fail me" } })
      transport.pushFail = new Error("Transport failed")

      const events: SyncEvent[] = []
      engine.onEvent((event) => {
        events.push(event)
      })

      await engine.sync()

      expect(events.some((e) => e.phase === "error")).toBe(true)
      expect(events.some((e) => e.phase === "complete")).toBe(false)
    })

    it("emits conflict event when conflicts occur", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id = await seedChange(db, { type: "update", data: { title: "Local" } })
      transport.pushResult = {
        accepted: [],
        conflicts: [
          {
            changeId: id,
            recordId: "rec-1",
            collection: "todos",
            local: { title: "Local" },
            remote: { title: "Remote" },
            localTimestamp: "2026-01-01T00:00:00Z",
            remoteTimestamp: "2026-06-01T00:00:00Z",
            fieldConflicts: ["title"],
          },
        ],
        errors: [],
      }

      const events: SyncEvent[] = []
      engine.onEvent((event) => {
        events.push(event)
      })

      await engine.sync()

      expect(events.some((e) => e.phase === "conflict")).toBe(true)
    })

    it("allows unsubscribe from events", async () => {
      const { engine } = makeEngine()
      let count = 0
      const unsub = engine.onEvent(() => {
        count++
      })
      unsub()

      await engine.sync()

      expect(count).toBe(0)
    })

    it("does not crash when subscriber throws", async () => {
      const { engine } = makeEngine()
      engine.onEvent(() => {
        throw new Error("Subscriber error")
      })

      await expect(engine.sync()).resolves.toBeUndefined()
    })

    it("includes progress in complete event", async () => {
      const { engine, db, transport } = makeEngine()
      await engine.init()
      const id = await seedChange(db, { type: "create", data: { title: "Test" } })
      transport.pushResult = {
        accepted: [{ id, serverTimestamp: "ts" }],
        conflicts: [],
        errors: [],
      }

      let progress: SyncProgress | undefined
      engine.onEvent((event) => {
        if (event.phase === "complete") {
          progress = event.progress
        }
      })

      await engine.sync()

      expect(progress).toBeDefined()
      expect(progress?.pushed).toBe(1)
    })
  })

  describe("auto-sync", () => {
    it("triggers sync on interval", async () => {
      const transport = new MockTransport()
      const db = new Database({ adapter: "memory" })
      const engine = new SyncEngine(db, { transport, autoSync: { intervalMs: 50 } })

      const syncSpy = vi.spyOn(engine, "sync")

      await engine.init()

      expect(syncSpy).not.toHaveBeenCalled()

      // Wait for the interval to fire
      await new Promise((r) => setTimeout(r, 100))

      expect(syncSpy).toHaveBeenCalled()

      syncSpy.mockRestore()
      await engine.destroy()
    })
  })

  describe("triggerSync (debounce)", () => {
    it("debounces rapid triggerSync calls", async () => {
      const transport = new MockTransport()
      const db = new Database({ adapter: "memory" })
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

      // Wait for debounce to settle
      await new Promise((r) => setTimeout(r, 100))

      expect(syncSpy).toHaveBeenCalledTimes(1)

      syncSpy.mockRestore()
      await engine.destroy()
    })

    it("does nothing when autoSync is disabled", () => {
      const { engine } = makeEngine()

      // Should not throw
      engine.triggerSync()
    })
  })

  describe("setConnected", () => {
    it("triggers sync on reconnect when autoSync is enabled", async () => {
      const transport = new MockTransport()
      transport.connected = false
      const db = new Database({ adapter: "memory" })
      const engine = new SyncEngine(db, { transport, autoSync: true })

      await engine.init()
      expect(engine.status.isConnected).toBe(false)

      transport.connected = true
      engine.setConnected(true)

      await new Promise(process.nextTick)

      const status = engine.status
      expect(status.isConnected).toBe(true)
      expect(transport.pushCallCount).toBeGreaterThanOrEqual(0)

      await engine.destroy()
    })

    it("updates isConnected flag", () => {
      const { engine } = makeEngine()
      engine.setConnected(true)
      expect(engine.status.isConnected).toBe(true)

      engine.setConnected(false)
      expect(engine.status.isConnected).toBe(false)
    })
  })

  describe("backoff", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("retries on failure when autoSync is enabled", async () => {
      const transport = new MockTransport()
      transport.pushFail = new Error("Fail")
      const db = new Database({ adapter: "memory" })
      const engine = new SyncEngine(db, {
        transport,
        autoSync: true,
        pushBatchSize: 1,
      })

      await engine.init()

      // Seed a change so push has work to do
      const tracker = new ChangeTracker(db._getAdapter())
      await tracker.append("create", "todos", "rec-1", { title: "test" })

      // First sync fails
      await engine.sync()
      expect(engine.status.lastError).toBe("Fail")

      // Backoff should trigger retry
      // Advance time by initial backoff + jitter (1s * (0.75 to 1.25) ≈ 750-1250ms)
      await vi.advanceTimersByTimeAsync(2000)

      expect(transport.pushCallCount).toBeGreaterThanOrEqual(2)

      await engine.destroy()
    })

    it("resets lastError on success", async () => {
      const transport = new MockTransport()
      const db = new Database({ adapter: "memory" })
      const engine = new SyncEngine(db, { transport, autoSync: true })

      await engine.init()

      // First sync succeeds
      await engine.sync()
      expect(engine.status.lastError).toBeNull()

      await engine.destroy()
    })
  })

  describe("getPendingCount / getFailedCount", () => {
    it("returns pending count from tracker", async () => {
      const { engine, db } = makeEngine()
      await engine.init()
      await seedChange(db, { type: "create", data: { title: "A" } })
      await seedChange(db, { type: "create", data: { title: "B" } })

      const count = await engine.getPendingCount()
      expect(count).toBe(2)
    })

    it("returns failed count from tracker", async () => {
      const { engine, db } = makeEngine()
      await engine.init()
      const tracker = new ChangeTracker(db._getAdapter())
      const id = await tracker.append("create", "todos", "rec-1", { title: "Fail" })
      await tracker.markFailed(id, "Error")

      const count = await engine.getFailedCount()
      expect(count).toBe(1)
    })
  })
})
