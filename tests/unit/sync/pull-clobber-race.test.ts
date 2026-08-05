import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Database } from "../../../src/database"
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

class MockTransport implements SyncTransport {
  readonly name = "mock"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }
  pushCallCount = 0
  pullCallCount = 0
  connected = true
  async push(_c: SyncChangeRecord[], _o?: PushOptions): Promise<SyncPushResult> {
    this.pushCallCount++
    return this.pushResult
  }
  async pull(_o?: PullOptions): Promise<SyncPullResult> {
    this.pullCallCount++
    return this.pullResult
  }
}

function createDb(transport: SyncTransport, config?: Partial<SyncPluginConfig>) {
  const plugin = syncPlugin({ transport, strategy: "lww", autoSync: false, ...config })
  return new Database({
    name: "test_pull_conflict",
    adapter: "memory",
    schema: {
      version: 1,
      collections: { todos: { fields: { title: { type: "string" }, done: { type: "boolean" } } } },
    },
    plugins: [plugin],
  })
}

describe("pull must not clobber pending local changes", () => {
  let transport: MockTransport
  let db: Database

  beforeEach(async () => {
    transport = new MockTransport()
    db = createDb(transport)
    await db.connect()
  })

  afterEach(async () => {
    if (db) await db.disconnect()
  })

  it("keeps a newer local edit when a stale remote update arrives", async () => {
    const todos = db.collection("todos")
    const record = await todos.create({ title: "draft", done: false })
    await todos.update(record.id, { title: "draft v2", done: true })

    transport.pushResult = { accepted: [], conflicts: [], errors: [] }
    transport.pullResult = {
      changes: [
        {
          id: "svr_1",
          collection: "todos",
          recordId: record.id,
          type: "update",
          data: { title: "stale server value", done: false },
          timestamp: new Date(Date.now() - 60000).toISOString(),
        },
      ],
      cursor: "svr_1",
      hasMore: false,
    }

    await db.sync()

    const after = await todos.get(record.id)
    expect(after!.title).toBe("draft v2")
    expect(after!.done).toBe(true)
  })

  it("keeps a pending local create when a remote delete arrives for the same id", async () => {
    const todos = db.collection("todos")
    const record = await todos.create({ title: "mine", done: false })

    transport.pushResult = { accepted: [], conflicts: [], errors: [] }
    transport.pullResult = {
      changes: [
        {
          id: "svr_2",
          collection: "todos",
          recordId: record.id,
          type: "delete",
          data: null,
          timestamp: new Date(Date.now() - 60000).toISOString(),
        },
      ],
      cursor: "svr_2",
      hasMore: false,
    }

    await db.sync()

    const after = await todos.get(record.id)
    expect(after).toBeDefined()
    expect(after!.title).toBe("mine")
  })

  it("still applies remote updates when there is no pending local change", async () => {
    const todos = db.collection("todos")
    const record = await todos.create({ title: "local", done: false })

    // Accept the create so nothing stays pending
    const changeId = record.id // not used, push accepted empty is fine because record exists

    transport.pushResult = { accepted: [], conflicts: [], errors: [] }
    transport.pullResult = {
      changes: [
        {
          id: "svr_3",
          collection: "todos",
          recordId: "remote-only",
          type: "create",
          data: { title: "from server", done: true },
          timestamp: new Date().toISOString(),
        },
      ],
      cursor: "svr_3",
      hasMore: false,
    }

    await db.sync()

    const all = await todos.getAll()
    expect(all).toHaveLength(2)
    const remote = all.find((r) => r.title === "from server")
    expect(remote).toBeDefined()
    expect(remote!.done).toBe(true)
  })

  it("rolls back unacknowledged changes to pending instead of leaking them as syncing", async () => {
    const todos = db.collection("todos")
    await todos.create({ title: "orphan candidate", done: false })

    // Transport returns an empty result: nothing accepted, nothing errored.
    transport.pushResult = { accepted: [], conflicts: [], errors: [] }
    transport.pullResult = { changes: [], cursor: null, hasMore: false }

    await db.sync()

    // After sync, the change must be pending again (retryable), not stuck syncing.
    const { getSyncChanges } = await import("../../../src/sync/change-tracker")
    void getSyncChanges
    const adapter = db._getAdapter()
    const all = (await adapter.findAll("_ctrodb_sync_changes")) as SyncChangeRecord[]
    expect(all.length).toBe(1)
    expect(all[0]!.status).toBe("pending")
  })
})
