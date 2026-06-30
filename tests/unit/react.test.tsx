// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import React from "react"
import { Database } from "../../src/database"
import {
  useQuery,
  useDoc,
  useMutation,
  useSyncStatus,
  useSync,
  DatabaseProvider,
} from "../../src/react"
import { syncPlugin } from "../../src/sync/sync-plugin"
import type {
  SyncChangeRecord,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
  PushOptions,
  PullOptions,
} from "../../src/sync/types"

const testSchema = {
  version: 1,
  collections: {
    tasks: {
      fields: {
        title: { type: "string", required: true },
        done: { type: "boolean", default: false },
      },
    },
  },
}

let db: Database

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(DatabaseProvider, { db, children })
}

beforeAll(async () => {
  db = new Database({ name: "react_test", adapter: "memory", schema: testSchema })
  await db.connect()
})

afterAll(async () => {
  await db.disconnect()
})

describe("useQuery", () => {
  it("returns loading true initially, then data on completion", async () => {
    const { result } = renderHook(() => useQuery("tasks"), { wrapper })

    expect(result.current.loading).toBe(true)
    expect(result.current.data).toEqual([])
    expect(result.current.error).toBeUndefined()

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
  })

  it("returns records after they are created", async () => {
    await act(async () => {
      await db.collection("tasks").create({ title: "Test Task", done: false })
    })

    const { result } = renderHook(() => useQuery("tasks"), { wrapper })

    await waitFor(() => {
      expect(result.current.data.length).toBeGreaterThanOrEqual(1)
    })

    const task = result.current.data.find((t: any) => t.title === "Test Task")
    expect(task).toBeDefined()
    expect((task as any).title).toBe("Test Task")
  })

  it("applies query filter", async () => {
    await act(async () => {
      await db.collection("tasks").create({ title: "Done Task", done: true })
    })

    const { result } = renderHook(() =>
      useQuery("tasks", (q) => q.where("done", "==", true)),
    { wrapper },
    )

    await waitFor(() => {
      expect(result.current.data.length).toBeGreaterThanOrEqual(1)
    })

    for (const task of result.current.data) {
      expect((task as any).done).toBe(true)
    }
  })
})

describe("useDoc", () => {
  it("returns undefined data for non-existent id", async () => {
    const { result } = renderHook(() => useDoc("tasks", 99999), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.data).toBeUndefined()
    })
  })

  it("returns a record by id", async () => {
    let createdId: any
    await act(async () => {
      const task = await db.collection("tasks").create({ title: "Doc Test" })
      createdId = task.id
    })

    const { result } = renderHook(() => useDoc("tasks", createdId), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.data).toBeDefined()
      expect((result.current.data as any).title).toBe("Doc Test")
    })
  })
})

describe("useMutation", () => {
  it("provides create, update, delete functions", () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    expect(typeof result.current.create).toBe("function")
    expect(typeof result.current.update).toBe("function")
    expect(typeof result.current.delete).toBe("function")
    expect(typeof result.current.reset).toBe("function")
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it("create adds a record", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    let created: any
    await act(async () => {
      created = await result.current.create({ title: "Mutation Test" })
    })

    expect(created).toBeDefined()
    expect((created as any).title).toBe("Mutation Test")
  })

  it("update modifies a record", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    let created: any
    await act(async () => {
      created = await result.current.create({ title: "Update Test" })
    })

    let updated: any
    await act(async () => {
      updated = await result.current.update(created.id, { title: "Updated" })
    })

    expect((updated as any).title).toBe("Updated")
  })

  it("delete removes a record", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    let created: any
    await act(async () => {
      created = await result.current.create({ title: "Delete Test" })
    })

    await act(async () => {
      await result.current.delete(created.id)
    })

    const found = await db.collection("tasks").get(created.id)
    expect(found).toBeUndefined()
  })

  it("reset clears error", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    act(() => {
      result.current.reset()
    })

    expect(result.current.error).toBeUndefined()
    expect(result.current.loading).toBe(false)
  })
})

describe("DatabaseProvider", () => {
  it("provides database through context", () => {
    const { result } = renderHook(() => useQuery("tasks"), { wrapper })

    expect(result.current).toHaveProperty("data")
    expect(result.current).toHaveProperty("loading")
    expect(result.current).toHaveProperty("error")
  })
})

// ── Mock Sync Transport ──

class MockSyncTransport implements SyncTransport {
  readonly name = "mock-sync"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }

  async push(_changes: SyncChangeRecord[], _options?: PushOptions): Promise<SyncPushResult> {
    return this.pushResult
  }

  async pull(_options?: PullOptions): Promise<SyncPullResult> {
    return this.pullResult
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true
  }
}

// ── Sync Hooks Tests ──

describe("useSyncStatus", () => {
  it("returns defaults when no sync plugin registered", async () => {
    const { result } = renderHook(() => useSyncStatus(), { wrapper })

    await waitFor(() => {
      expect(result.current.isSyncing).toBe(false)
      expect(result.current.isConnected).toBe(false)
    })

    expect(result.current.pendingChanges).toBe(0)
    expect(result.current.failedChanges).toBe(0)
    expect(result.current.lastSyncAt).toBeNull()
    expect(result.current.lastError).toBeNull()
  })
})

describe("useSyncStatus (with sync plugin)", () => {
  let syncDb: Database
  let transport: MockSyncTransport

  function syncWrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(DatabaseProvider, { db: syncDb, children })
  }

  beforeEach(async () => {
    transport = new MockSyncTransport()
    const plugin = syncPlugin({ transport, strategy: "lww", autoSync: false })
    syncDb = new Database({
      name: "sync_hooks_test",
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          items: {
            fields: { label: { type: "string" } },
          },
        },
      },
      plugins: [plugin],
    })
    await syncDb.connect()
    const engine = (syncDb.plugin("sync") as { _engine: { init(): Promise<void> } })._engine
    await engine.init()
  })

  afterEach(async () => {
    await syncDb.disconnect()
  })

  it("returns initial sync status from engine", async () => {
    const { result } = renderHook(() => useSyncStatus(), { wrapper: syncWrapper })

    await waitFor(() => {
      expect(result.current.isSyncing).toBe(false)
      expect(result.current.isConnected).toBe(true)
    })

    expect(result.current.lastError).toBeNull()
    expect(typeof result.current.pendingChanges).toBe("number")
    expect(typeof result.current.failedChanges).toBe("number")
  })
})

describe("useSync", () => {
  let syncDb: Database
  let transport: MockSyncTransport

  function syncWrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(DatabaseProvider, { db: syncDb, children })
  }

  beforeEach(async () => {
    transport = new MockSyncTransport()
    const plugin = syncPlugin({ transport, strategy: "lww", autoSync: false })
    syncDb = new Database({
      name: "sync_hooks_test2",
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          items: {
            fields: { label: { type: "string" } },
          },
        },
      },
      plugins: [plugin],
    })
    await syncDb.connect()
    const engine = (syncDb.plugin("sync") as { _engine: { init(): Promise<void> } })._engine
    await engine.init()
  })

  afterEach(async () => {
    await syncDb.disconnect()
  })

  it("returns sync function and status", () => {
    const { result } = renderHook(() => useSync(), { wrapper: syncWrapper })

    expect(typeof result.current.sync).toBe("function")
    expect(result.current.status).toBeDefined()
    expect(typeof result.current.status.isSyncing).toBe("boolean")
  })

  it("sync function delegates to db.sync()", async () => {
    const spy = vi.spyOn(syncDb, "sync")

    const { result } = renderHook(() => useSync(), { wrapper: syncWrapper })

    await act(async () => {
      await result.current.sync()
    })

    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it("calls event callback when sync events fire", async () => {
    const callback = vi.fn()

    renderHook(() => useSync(callback), { wrapper: syncWrapper })

    await act(async () => {
      await syncDb.sync()
    })

    expect(callback).toHaveBeenCalled()
    const event = callback.mock.calls[0]![0]
    expect(event.type).toBe("sync")
  })
})
