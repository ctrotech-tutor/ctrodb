import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Database } from "../../../src/database"
import { SYNC_STORE } from "../../../src/sync/change-tracker"
import {
  clearCommittedSync,
  compactSyncQueue,
  createSyncEventLog,
  getSyncStats,
  inspectSyncQueue,
  retryFailedSync,
} from "../../../src/sync/devtools"
import { syncPlugin } from "../../../src/sync/sync-plugin"
import type {
  SyncChangeRecord,
  SyncPluginConfig,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
  PushOptions,
  PullOptions,
} from "../../../src/sync/types"

// ── Mock Transport ──

class MockTransport implements SyncTransport {
  readonly name = "mock"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }
  pushCallCount = 0
  pullCallCount = 0

  async push(_changes: SyncChangeRecord[], _options?: PushOptions): Promise<SyncPushResult> {
    this.pushCallCount++
    return this.pushResult
  }

  async pull(_options?: PullOptions): Promise<SyncPullResult> {
    this.pullCallCount++
    return this.pullResult
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true
  }
}

// ── Helpers ──

function createDb(transport: SyncTransport, config?: Partial<SyncPluginConfig>) {
  const plugin = syncPlugin({
    transport,
    strategy: "lww",
    autoSync: false,
    ...config,
  })
  const db = new Database({
    name: "test_devtools",
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
  return { db, plugin }
}

async function seedChanges(
  db: Database,
  overrides: Array<{
    type?: "create" | "update" | "delete"
    collection?: string
    recordId?: string
    status?: "pending" | "syncing" | "committed" | "failed"
    data?: Record<string, unknown> | null
  }>,
): Promise<string[]> {
  const adapter = db._getAdapter()
  const ids: string[] = []
  for (const override of overrides) {
    const id = `change_${ids.length}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    const record: SyncChangeRecord = {
      id,
      collection: override.collection ?? "todos",
      recordId: override.recordId ?? `rec-${ids.length}`,
      type: override.type ?? "create",
      data: override.data ?? { title: "test" },
      prevData: null,
      timestamp: now,
      status: override.status ?? "pending",
      retries: 0,
      errorMessage: override.status === "failed" ? "test error" : null,
      createdAt: now,
      updatedAt: now,
    }
    await adapter.create(SYNC_STORE, record as unknown as Record<string, unknown>)
    ids.push(id)
  }
  return ids
}

describe("DevTools", () => {
  let transport: MockTransport
  let db: Database

  beforeEach(async () => {
    transport = new MockTransport()
    const ctx = createDb(transport)
    db = ctx.db
    await db.connect()
  })

  afterEach(async () => {
    await db.disconnect()
  })

  // ── inspectSyncQueue ──

  describe("inspectSyncQueue", () => {
    it("returns empty state when queue has no changes", async () => {
      const snapshot = await inspectSyncQueue(db)

      expect(snapshot.pending).toEqual([])
      expect(snapshot.syncing).toEqual([])
      expect(snapshot.committed).toEqual([])
      expect(snapshot.failed).toEqual([])
      expect(snapshot.stats).toEqual({
        total: 0,
        pending: 0,
        syncing: 0,
        committed: 0,
        failed: 0,
      })
    })

    it("groups changes by status", async () => {
      await seedChanges(db, [
        { type: "create", status: "pending" },
        { type: "create", status: "pending" },
        { type: "update", status: "syncing" },
        { type: "update", status: "committed" },
        { type: "delete", status: "failed" },
      ])

      const snapshot = await inspectSyncQueue(db)

      expect(snapshot.pending).toHaveLength(2)
      expect(snapshot.syncing).toHaveLength(1)
      expect(snapshot.committed).toHaveLength(1)
      expect(snapshot.failed).toHaveLength(1)
      expect(snapshot.stats).toEqual({
        total: 5,
        pending: 2,
        syncing: 1,
        committed: 1,
        failed: 1,
      })
    })

    it("throws if sync plugin is not registered", async () => {
      const db2 = new Database({ name: "test_no_sync", adapter: "memory" })
      await expect(inspectSyncQueue(db2)).rejects.toThrow(
        "Sync plugin not registered",
      )
      await db2.disconnect()
    })
  })

  // ── getSyncStats ──

  describe("getSyncStats", () => {
    it("returns queue stats without full data", async () => {
      await seedChanges(db, [
        { type: "create", status: "pending" },
        { type: "create", status: "committed" },
      ])

      const stats = await getSyncStats(db)

      expect(stats).toEqual({
        total: 2,
        pending: 1,
        syncing: 0,
        committed: 1,
        failed: 0,
      })
    })
  })

  // ── retryFailedSync ──

  describe("retryFailedSync", () => {
    it("marks failed changes as pending and triggers sync", async () => {
      const [id1, id2] = await seedChanges(db, [
        { type: "create", status: "failed" },
        { type: "create", status: "failed" },
      ])

      const count = await retryFailedSync(db)

      expect(count).toBe(2)

      // After retry, changes were markPending'd then immediately sync'd.
      // By the time retryFailedSync resolves, the changes are "syncing"
      // because pushChanges() atomically transitions pending→syncing.
      expect(transport.pushCallCount).toBe(1)
    })

    it("returns 0 when no failed changes exist", async () => {
      await seedChanges(db, [
        { type: "create", status: "pending" },
      ])

      const count = await retryFailedSync(db)

      expect(count).toBe(0)
    })

    it("throws if sync plugin is not registered", async () => {
      const db2 = new Database({ name: "test_no_sync", adapter: "memory" })
      await expect(retryFailedSync(db2)).rejects.toThrow(
        "Sync plugin not registered",
      )
      await db2.disconnect()
    })
  })

  // ── clearCommittedSync ──

  describe("clearCommittedSync", () => {
    it("removes all committed changes", async () => {
      await seedChanges(db, [
        { type: "create", status: "committed" },
        { type: "create", status: "committed" },
        { type: "create", status: "pending" },
      ])

      const count = await clearCommittedSync(db)

      expect(count).toBe(2)

      const snapshot = await inspectSyncQueue(db)
      expect(snapshot.stats.total).toBe(1)
      expect(snapshot.pending).toHaveLength(1)
    })

    it("returns 0 when no committed changes exist", async () => {
      const count = await clearCommittedSync(db)
      expect(count).toBe(0)
    })

    it("works without sync plugin registered", async () => {
      const db2 = new Database({ name: "test_no_sync", adapter: "memory" })
      const count = await clearCommittedSync(db2)
      expect(count).toBe(0)
      await db2.disconnect()
    })
  })

  // ── compactSyncQueue ──

  describe("compactSyncQueue", () => {
    it("removes older pending changes for the same (collection, recordId)", async () => {
      // Seed with staggered timestamps so sort order is deterministic
      await seedChanges(db, [
        { type: "create", recordId: "rec-1", status: "pending", data: { title: "v1" } },
      ])
      await new Promise((r) => setTimeout(r, 5))
      await seedChanges(db, [
        { type: "update", recordId: "rec-1", status: "pending", data: { title: "v2" } },
      ])

      const removed = await compactSyncQueue(db)

      expect(removed).toBe(1)

      const snapshot = await inspectSyncQueue(db)
      expect(snapshot.stats.total).toBe(1)
      expect(snapshot.pending[0]?.data).toEqual({ title: "v2" })
    })

    it("removes older failed changes for the same (collection, recordId)", async () => {
      await seedChanges(db, [
        { type: "create", recordId: "rec-1", status: "failed", data: { title: "v1" } },
        { type: "update", recordId: "rec-1", status: "failed", data: { title: "v2" } },
      ])

      const removed = await compactSyncQueue(db)

      expect(removed).toBe(1)
    })

    it("handles multiple groups", async () => {
      await seedChanges(db, [
        { type: "create", recordId: "rec-1", status: "pending", data: { title: "a1" } },
        { type: "update", recordId: "rec-1", status: "pending", data: { title: "a2" } },
        { type: "create", recordId: "rec-2", status: "pending", data: { title: "b1" } },
        { type: "update", recordId: "rec-2", status: "pending", data: { title: "b2" } },
      ])

      const removed = await compactSyncQueue(db)

      expect(removed).toBe(2)
      expect((await inspectSyncQueue(db)).stats.total).toBe(2)
    })

    it("does not touch changes with unique (collection, recordId)", async () => {
      await seedChanges(db, [
        { type: "create", recordId: "rec-1", status: "pending" },
        { type: "create", recordId: "rec-2", status: "pending" },
      ])

      const removed = await compactSyncQueue(db)

      expect(removed).toBe(0)
      expect((await inspectSyncQueue(db)).stats.total).toBe(2)
    })

    it("does not touch committed or syncing changes", async () => {
      await seedChanges(db, [
        { type: "create", recordId: "rec-1", status: "committed" },
        { type: "create", recordId: "rec-1", status: "syncing" },
      ])

      const removed = await compactSyncQueue(db)

      expect(removed).toBe(0)
      expect((await inspectSyncQueue(db)).stats.total).toBe(2)
    })

    it("returns 0 for empty queue", async () => {
      const removed = await compactSyncQueue(db)
      expect(removed).toBe(0)
    })

    it("throws if sync plugin is not registered", async () => {
      const db2 = new Database({ name: "test_no_sync", adapter: "memory" })
      await expect(compactSyncQueue(db2)).rejects.toThrow(
        "Sync plugin not registered",
      )
      await db2.disconnect()
    })
  })

  // ── createSyncEventLog ──

  describe("createSyncEventLog", () => {
    it("collects sync events", async () => {
      const { events, stop } = createSyncEventLog(db, 10)

      // Simulate sync events by triggering sync
      transport.pushResult = {
        accepted: [{ id: "test-1", serverTimestamp: new Date().toISOString() }],
        conflicts: [],
        errors: [],
      }
      await db.sync()

      expect(events.length).toBeGreaterThan(0)
      const phases = events.map((e) => e.phase)
      expect(phases).toContain("push")
      expect(phases).toContain("pull")
      expect(phases).toContain("complete")

      stop()
    })

    it("respects maxSize limit", async () => {
      const { events, stop } = createSyncEventLog(db, 3)

      // Each sync() emits at least push + pull + complete phases
      for (let i = 0; i < 5; i++) {
        await db.sync()
      }

      expect(events.length).toBeLessThanOrEqual(3)

      stop()
    })

    it("stops collecting after stop() is called", async () => {
      const { events, stop } = createSyncEventLog(db, 100)

      stop()

      await db.sync()

      const preStopLength = events.length

      // Wait to ensure no events arrive asynchronously
      await new Promise((r) => setTimeout(r, 30))

      expect(events.length).toBe(preStopLength)
    })
  })
})
