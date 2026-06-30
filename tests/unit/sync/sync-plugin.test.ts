import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Database } from "../../../src/database"
import { syncPlugin } from "../../../src/sync/sync-plugin"
import { SyncEngine } from "../../../src/sync/sync-engine"
import { SYNC_STORE } from "../../../src/sync/change-tracker"
import type {
  SyncChangeRecord,
  SyncEvent,
  SyncPluginConfig,
  SyncPullResult,
  SyncPushResult,
  SyncStatus,
  SyncTransport,
  PushOptions,
  PullOptions,
} from "../../../src/sync/types"

// ── Mock Transport ──

class MockTransport implements SyncTransport {
  readonly name = "mock"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }
  pushFail: Error | null = null
  pullFail: Error | null = null
  pushCallCount = 0
  pullCallCount = 0

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
    name: "test_sync_plugin",
    adapter: "memory",
    schema: {
      version: 1,
      collections: {
        todos: {
          fields: { title: { type: "string" }, done: { type: "boolean" } },
        },
        notes: {
          fields: { content: { type: "string" } },
        },
      },
    },
    plugins: [plugin],
  })
  return { db, plugin }
}

async function getChanges(db: Database): Promise<SyncChangeRecord[]> {
  const adapter = db._getAdapter()
  return (await adapter.findAll(SYNC_STORE)) as SyncChangeRecord[]
}

// ── Tests ──

describe("syncPlugin", () => {
  let transport: MockTransport

  beforeEach(() => {
    transport = new MockTransport()
  })

  afterEach(async () => {
    vi.useRealTimers()
  })

  describe("factory", () => {
    it("creates a plugin with valid config", () => {
      const plugin = syncPlugin({ transport, strategy: "lww" })
      expect(plugin).toBeDefined()
      expect(plugin.name).toBe("sync")
      expect(plugin.version).toBe("1.0.0")
      expect(plugin.storeNames).toEqual([SYNC_STORE])
    })

    it("has no _engine before database init", () => {
      const plugin = syncPlugin({ transport, strategy: "lww" })
      expect(plugin._engine).toBeUndefined()
    })

    it("does not require a schema to create", () => {
      const plugin = syncPlugin({ transport, strategy: "lww" })
      expect(plugin._engine).toBeUndefined()
    })
  })

  describe("onDatabaseInit", () => {
    it("creates SyncEngine and ChangeTracker on connect", async () => {
      const { db, plugin } = createDb(transport)

      expect(plugin._engine).toBeUndefined()

      await db.connect()

      expect(plugin._engine).toBeDefined()
      expect(plugin._engine).toBeInstanceOf(SyncEngine)
    })

    it("creates the _ctrodb_sync_changes store", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const adapter = db._getAdapter()
      const all = await adapter.findAll(SYNC_STORE)
      expect(all).toEqual([])
    })
  })

  describe("change tracking", () => {
    it("tracks creates via onAfterCreate hook", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const todos = db.collection("todos")
      const record = await todos.create({ title: "Test todo", done: false })

      const changes = await getChanges(db)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.type).toBe("create")
      expect(changes[0]!.collection).toBe("todos")
      expect(changes[0]!.recordId).toBe(record.id)
      expect(changes[0]!.status).toBe("pending")
    })

    it("tracks updates via onAfterUpdate hook", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const todos = db.collection("todos")
      const record = await todos.create({ title: "Test", done: false })
      await todos.update(record.id, { done: true })

      const changes = await getChanges(db)
      expect(changes).toHaveLength(2)
      const updateChange = changes.find((c) => c.type === "update")
      expect(updateChange).toBeDefined()
      expect(updateChange!.collection).toBe("todos")
      expect(updateChange!.recordId).toBe(record.id)
    })

    it("tracks deletes via onAfterDelete hook", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const todos = db.collection("todos")
      const record = await todos.create({ title: "Test", done: false })
      await todos.delete(record.id)

      const changes = await getChanges(db)
      expect(changes).toHaveLength(2)
      const deleteChange = changes.find((c) => c.type === "delete")
      expect(deleteChange).toBeDefined()
      expect(deleteChange!.collection).toBe("todos")
      expect(deleteChange!.recordId).toBe(record.id)
    })

    it("tracks changes across multiple collections", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const todos = db.collection("todos")
      const notes = db.collection("notes")

      await todos.create({ title: "Todo 1", done: false })
      await notes.create({ content: "Note 1" })
      await todos.create({ title: "Todo 2", done: true })

      const changes = await getChanges(db)
      expect(changes).toHaveLength(3)
      expect(changes.filter((c) => c.collection === "todos")).toHaveLength(2)
      expect(changes.filter((c) => c.collection === "notes")).toHaveLength(1)
    })

    it("does not sync loop when remote changes are applied (adapter bypass)", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const adapter = db._getAdapter()
      await adapter.create(SYNC_STORE, {
        id: "chg-existing",
        collection: "todos",
        recordId: "rec-existing",
        type: "create",
        data: { title: "Existing pending change" },
        prevData: null,
        timestamp: new Date().toISOString(),
        status: "pending",
        retries: 0,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as unknown as Record<string, unknown>)

      const changes = await getChanges(db)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.status).toBe("pending")
    })
  })

  describe("database convenience API", () => {
    it("db.plugin('sync') returns the sync plugin", async () => {
      const { db, plugin } = createDb(transport)
      await db.connect()

      const retrieved = db.plugin("sync")
      expect(retrieved).toBe(plugin)
      expect(retrieved?.name).toBe("sync")
    })

    it("db.plugin('nonexistent') returns undefined", async () => {
      const { db } = createDb(transport)
      await db.connect()

      expect(db.plugin("nonexistent")).toBeUndefined()
    })

    it("db.sync() delegates to engine.sync()", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const spy = vi.spyOn(
        (db.plugin("sync") as { _engine: SyncEngine })._engine,
        "sync",
      )

      await db.sync()

      expect(spy).toHaveBeenCalledTimes(1)
    })

    it("db.sync() returns when no pending changes", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const result = db.sync()
      await expect(result).resolves.toBeUndefined()
    })

    it("db.onSync() registers event callback", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const callback = vi.fn()
      const unsub = db.onSync(callback)

      const engine = (db.plugin("sync") as { _engine: SyncEngine })._engine
      await engine.sync()

      expect(callback).toHaveBeenCalled()
      const events = callback.mock.calls.map((c) => c[0]) as SyncEvent[]
      const completeEvent = events.find((e) => e.phase === "complete")
      expect(completeEvent).toBeDefined()
      expect(completeEvent!.type).toBe("sync")

      unsub()
    })

    it("db.onSync() returns unsubscribe function", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const callback = vi.fn()
      const unsub = db.onSync(callback)
      unsub()

      const engine = (db.plugin("sync") as { _engine: SyncEngine })._engine
      await engine.sync()

      expect(callback).not.toHaveBeenCalled()
    })

    it("db.syncStatus returns SyncStatus object", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const status: SyncStatus = db.syncStatus
      expect(status).toBeDefined()
      expect(typeof status.isSyncing).toBe("boolean")
      expect(typeof status.isConnected).toBe("boolean")
    })
  })

  describe("error handling", () => {
    it("db.sync() throws when no sync plugin registered", async () => {
      const db = new Database({ adapter: "memory" })
      await db.connect()

      await expect(db.sync()).rejects.toThrow("Sync plugin not registered")
    })

    it("db.onSync() throws when no sync plugin registered", async () => {
      const db = new Database({ adapter: "memory" })
      await db.connect()

      expect(() => db.onSync(vi.fn())).toThrow("Sync plugin not registered")
    })

    it("db.syncStatus accessor throws when no sync plugin registered", async () => {
      const db = new Database({ adapter: "memory" })
      await db.connect()

      expect(() => db.syncStatus).toThrow("Sync plugin not registered")
    })
  })

  describe("integration with other plugins", () => {
    it("works alongside FTS plugin without interference", async () => {
      const { ftsPlugin } = await import("../../../src/plugins/fts/index")
      const sync = syncPlugin({ transport, strategy: "lww", autoSync: false })

      const db = new Database({
        adapter: "memory",
        schema: {
          version: 1,
          collections: {
            articles: {
              fields: { title: { type: "string", required: true }, body: { type: "string" } },
              searchable: ["title", "body"],
            },
          },
        },
        plugins: [ftsPlugin(), sync],
      })

      await db.connect()

      const articles = db.collection("articles")
      await articles.create({ title: "Test", body: "Hello world" })

      const changes = await getChanges(db)
      expect(changes).toHaveLength(1)
      expect(changes[0]!.type).toBe("create")
    })
  })

  describe("SyncEngine via plugin", () => {
    it("engine can sync changes tracked by plugin hooks", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const todos = db.collection("todos")
      await todos.create({ title: "Sync me", done: false })

      const engine = (db.plugin("sync") as { _engine: SyncEngine })._engine
      await engine.sync()

      expect(transport.pushCallCount).toBeGreaterThanOrEqual(1)
    })

    it("engine status reflects sync state", async () => {
      const { db } = createDb(transport)
      await db.connect()

      const engine = (db.plugin("sync") as { _engine: SyncEngine })._engine
      const status = engine.status
      expect(status.isSyncing).toBe(false)
      expect(typeof status.pendingChanges).toBe("number")
      expect(typeof status.failedChanges).toBe("number")
    })
  })
})
