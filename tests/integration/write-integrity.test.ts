/**
 * Regression tests for the write-integrity batch:
 *
 *  - H-06  duplicate ids silently overwrote records on the memory adapter, and
 *          unique indexes were enforced by IndexedDB but not in memory.
 *  - H-09  a failing "after" hook rejected a write that had already committed.
 *  - H-10  the FTS plugin fired indexing work without awaiting it, so failures
 *          surfaced as unhandled rejections.
 *  - H-11  a blocked IndexedDB upgrade logged a warning and never settled.
 *  - H-12  indexes added to the schema after the store existed were never
 *          created, so queries silently stopped using them.
 *  - H-15  `client-wins` marked a rejected change as committed, dropping it and
 *          leaving the two sides permanently diverged.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { IndexedDBAdapter } from "../../src/adapter/idb"
import { Database } from "../../src/database"
import { ChangeTracker } from "../../src/sync/change-tracker"
import { syncPlugin } from "../../src/sync/sync-plugin"
import type {
  PullOptions,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "../../src/sync/types"
import type { CtroDBPlugin } from "../../src/types"

const schema = {
  version: 1,
  collections: {
    users: {
      fields: { email: { type: "string" }, name: { type: "string" } },
      indexes: [{ field: "email", unique: true }],
    },
  },
} as const

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

const open: Database[] = []

async function makeDb(options: {
  adapter?: "memory" | "indexeddb"
  name?: string
  schema?: unknown
  plugins?: CtroDBPlugin[]
}): Promise<Database> {
  const db = new Database({
    name: options.name ?? uniqueName("integrity"),
    adapter: options.adapter ?? "memory",
    schema: (options.schema ?? schema) as never,
    plugins: options.plugins,
  })
  await db.connect()
  open.push(db)
  return db
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
  vi.restoreAllMocks()
})

describe.each([
  "memory",
  "indexeddb",
] as const)("duplicate ids and unique indexes (%s)", (adapter) => {
  it("rejects a second create with the same id instead of overwriting", async () => {
    const db = await makeDb({ adapter })
    const users = db.collection("users")
    await users.create({ id: "u1", email: "a@example.com", name: "Original" })

    await expect(
      users.create({ id: "u1", email: "b@example.com", name: "Clobber" }),
    ).rejects.toThrow(/already exists/)

    // The original record must be untouched.
    expect((await users.get("u1"))?.name).toBe("Original")
  })

  it("enforces unique indexes", async () => {
    const db = await makeDb({ adapter })
    const users = db.collection("users")
    await users.create({ id: "u1", email: "dup@example.com", name: "First" })

    await expect(
      users.create({ id: "u2", email: "dup@example.com", name: "Second" }),
    ).rejects.toThrow(/unique constraint/i)

    expect(await users.get("u2")).toBeUndefined()
  })
})

describe("after hooks never corrupt a committed write (H-09)", () => {
  it("resolves the write when an after hook throws", async () => {
    const exploding: CtroDBPlugin = {
      name: "exploding",
      onAfterCreate() {
        throw new Error("boom")
      },
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const db = await makeDb({ plugins: [exploding] })

    const created = await db.collection("users").create({ id: "u1", email: "a@b.c", name: "Ada" })

    expect(created.id).toBe("u1")
    expect(await db.collection("users").get("u1")).toBeDefined()
    expect(spy).toHaveBeenCalled()
  })

  it("does not emit an unhandledRejection from a failing after hook", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on("unhandledRejection", onUnhandled)

    const exploding: CtroDBPlugin = {
      name: "exploding",
      async onAfterUpdate() {
        throw new Error("async boom")
      },
    }
    const db = await makeDb({ plugins: [exploding] })
    await db.collection("users").create({ id: "u1", email: "a@b.c", name: "Ada" })
    await db.collection("users").update("u1", { name: "Grace" })

    await new Promise((resolve) => setTimeout(resolve, 25))
    process.off("unhandledRejection", onUnhandled)

    expect(seen).toEqual([])
    expect(spy).toHaveBeenCalled()
  })
})

describe("IndexedDB upgrade handling", () => {
  it("creates indexes added to the schema by a later version (H-12)", async () => {
    const name = uniqueName("upgrade")

    const v1 = await makeDb({
      adapter: "indexeddb",
      name,
      schema: {
        version: 1,
        collections: { users: { fields: { email: { type: "string" }, age: { type: "number" } } } },
      },
    })
    await v1.collection("users").create({ id: "u1", email: "a@b.c", age: 30 })
    await v1.disconnect()

    const v2 = await makeDb({
      adapter: "indexeddb",
      name,
      schema: {
        version: 2,
        collections: {
          users: {
            fields: { email: { type: "string" }, age: { type: "number" } },
            indexes: [{ field: "age" }],
          },
        },
      },
    })

    // The index must exist on the upgraded store, not just in the schema.
    const indexNames = await new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction("users", "readonly")
        const names = [...tx.objectStore("users").indexNames]
        db.close()
        resolve(names)
      }
      request.onerror = () => reject(request.error)
    })
    expect(indexNames).toContain("age")

    // …and the data survived the upgrade.
    expect(await v2.collection("users").get("u1")).toBeDefined()
  })

  it("rejects instead of hanging when the upgrade is blocked (H-11)", async () => {
    const adapter = new IndexedDBAdapter()
    const originalIndexedDB = globalThis.indexedDB

    // Simulate another tab holding the connection open.
    const blockedRequest = {
      result: undefined,
      error: null,
      transaction: null,
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
      onupgradeneeded: null as null | (() => void),
      onblocked: null as null | (() => void),
    }
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open: () => {
          setTimeout(() => blockedRequest.onblocked?.(), 0)
          return blockedRequest
        },
      },
    })

    try {
      await expect(adapter.connect("blocked-db", null)).rejects.toThrow(/blocked/i)
      expect(adapter.isConnected()).toBe(false)
    } finally {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: originalIndexedDB,
      })
    }
  })
})

describe("client-wins does not drop a rejected change (H-15)", () => {
  class ConflictTransport implements SyncTransport {
    readonly name = "conflict"
    pullCalls = 0
    pushCalls = 0

    async push(): Promise<SyncPushResult> {
      this.pushCalls++
      return {
        accepted: [],
        conflicts: [
          {
            changeId: this.pendingChangeId,
            recordId: "u1",
            collection: "users",
            local: { name: "Local" },
            remote: { name: "Remote" },
            localTimestamp: "2026-01-01T00:00:10Z",
            remoteTimestamp: "2026-01-01T00:00:00Z",
            fieldConflicts: ["name"],
          },
        ],
        errors: [],
      }
    }

    pendingChangeId = ""

    async pull(_options?: PullOptions): Promise<SyncPullResult> {
      this.pullCalls++
      return { changes: [], cursor: null, hasMore: false }
    }
  }

  it("retries the push and only gives up after bounded attempts", async () => {
    const transport = new ConflictTransport()
    const db = await makeDb({
      adapter: "memory",
      plugins: [syncPlugin({ transport, strategy: "client-wins", autoSync: false })],
    })

    const created = await db.collection("users").create({ id: "u1", email: "a@b.c", name: "Local" })
    expect(created.id).toBe("u1")

    const tracker = new ChangeTracker(db._getAdapter())
    const queued = await tracker.getPending()
    expect(queued).toHaveLength(1)
    transport.pendingChangeId = queued[0]?.id ?? ""

    await db.sync()
    // Still queued: the server never accepted it.
    expect((await tracker.getById(transport.pendingChangeId))?.status).toBe("pending")

    await db.sync()
    await db.sync()
    await db.sync()

    // Bounded retries, then an explicit failure — never a silent drop.
    const record = await tracker.getById(transport.pendingChangeId)
    expect(record?.status).toBe("failed")
    expect(record?.errorMessage).toMatch(/rejected/i)
  })
})
