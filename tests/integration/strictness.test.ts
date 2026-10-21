/**
 * Regression tests for the strictness batch:
 *
 *  - M-04  `array`/`object` field types accepted the wrong shapes (everything
 *          is `typeof "object"`), and `NaN` was accepted as a number
 *  - M-05  collections missing from the schema were created silently and
 *          bypassed validation entirely
 *  - M-06  the write path threw bare `Error`s instead of the exported typed
 *          error classes
 *  - M-08  the `collections` sync filter applied to pull but not push
 *  - M-11  `WsTransport.onServerPush` was never subscribed, so real-time
 *          pushes waited for the next scheduled pull
 */
import { afterEach, describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import { CollectionNotFoundError, RecordNotFoundError, ValidationError } from "../../src/errors"
import { syncPlugin } from "../../src/sync/sync-plugin"
import type {
  PullOptions,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "../../src/sync/types"

const open: Database[] = []

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
})

function track(db: Database): Database {
  open.push(db)
  return db
}

const schema = {
  version: 1,
  collections: {
    items: {
      fields: {
        title: { type: "string" },
        qty: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object" },
      },
    },
    other: { fields: { note: { type: "string" } } },
  },
} as const

async function makeDb(): Promise<Database> {
  const db = track(
    new Database({
      name: `strict-${Math.random().toString(36).slice(2)}`,
      adapter: "memory",
      schema: schema as never,
    }),
  )
  await db.connect()
  return db
}

describe("schema type checking (M-04)", () => {
  it("rejects a non-array for an array field", async () => {
    const db = await makeDb()
    await expect(
      db.collection("items").create({ title: "t", tags: { 0: "a" } as never }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it("rejects an array or null for an object field", async () => {
    const db = await makeDb()
    await expect(
      db.collection("items").create({ title: "t", meta: ["a"] as never }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      db.collection("items").create({ title: "t", meta: null as never }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it("rejects NaN as a number", async () => {
    const db = await makeDb()
    await expect(
      db.collection("items").create({ title: "t", qty: Number.NaN }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it("accepts valid shapes and validates array items", async () => {
    const db = await makeDb()
    const items = db.collection("items")

    await expect(
      items.create({ id: "ok", title: "t", qty: 1, tags: ["a"], meta: { any: true } }),
    ).resolves.toBeDefined()

    await expect(
      items.create({ id: "bad-item", title: "t", tags: [42 as never] }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe("undeclared collections (M-05)", () => {
  it("throws a typed error listing the available collections", async () => {
    const db = await makeDb()

    expect(() => db.collection("ghost")).toThrow(CollectionNotFoundError)
    expect(() => db.collection("ghost")).toThrow(/Available collections: items, other/)
  })

  it("allows internal underscore-prefixed stores", async () => {
    const db = await makeDb()
    expect(() => db.collection("_internal")).not.toThrow()
  })

  it("still allows any collection when no schema is configured", async () => {
    const db = track(
      new Database({ name: `noschema-${Math.random().toString(36).slice(2)}`, adapter: "memory" }),
    )
    await db.connect()
    expect(() => db.collection("anything")).not.toThrow()
  })
})

describe("typed errors (M-06)", () => {
  it("throws RecordNotFoundError when updating a missing record", async () => {
    const db = await makeDb()
    await expect(db.collection("items").update("missing", { qty: 1 })).rejects.toBeInstanceOf(
      RecordNotFoundError,
    )
  })
})

describe("sync collections filter (M-08)", () => {
  class RecordingTransport implements SyncTransport {
    readonly name = "recording"
    pushed: string[] = []

    async push(changes): Promise<SyncPushResult> {
      for (const change of changes) this.pushed.push(change.collection)
      return {
        accepted: changes.map((c) => ({ id: c.id, serverTimestamp: new Date().toISOString() })),
        conflicts: [],
        errors: [],
      }
    }

    async pull(_options?: PullOptions): Promise<SyncPullResult> {
      return { changes: [], cursor: null, hasMore: false }
    }
  }

  it("only pushes collections that are configured", async () => {
    const transport = new RecordingTransport()
    const db = track(
      new Database({
        name: `filter-${Math.random().toString(36).slice(2)}`,
        adapter: "memory",
        schema: schema as never,
        plugins: [syncPlugin({ transport, autoSync: false, collections: ["items"] })],
      }),
    )
    await db.connect()

    await db.collection("items").create({ id: "i1", title: "kept" })
    await db.collection("other").create({ id: "o1", note: "filtered out" })

    await db.sync()

    expect(new Set(transport.pushed)).toEqual(new Set(["items"]))
  })
})

describe("real-time server pushes (M-11)", () => {
  it("subscribes to onServerPush and pulls when the server pushes", async () => {
    let serverPush: (() => void) | null = null
    let pullCalls = 0

    const transport: SyncTransport & { onServerPush(cb: () => void): () => void } = {
      name: "pushy",
      async push(): Promise<SyncPushResult> {
        return { accepted: [], conflicts: [], errors: [] }
      },
      async pull(_options?: PullOptions): Promise<SyncPullResult> {
        pullCalls++
        return { changes: [], cursor: null, hasMore: false }
      },
      onServerPush(callback: () => void) {
        serverPush = callback
        return () => {
          serverPush = null
        }
      },
    }

    const db = track(
      new Database({
        name: `realtime-${Math.random().toString(36).slice(2)}`,
        adapter: "memory",
        schema: schema as never,
        plugins: [syncPlugin({ transport, autoSync: { debounceMs: 5, intervalMs: 60_000 } })],
      }),
    )
    await db.connect()
    expect(serverPush).not.toBeNull()

    const before = pullCalls
    ;(serverPush as unknown as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(pullCalls).toBeGreaterThan(before)

    await db.disconnect()
    // The subscription is released with the engine.
    expect(serverPush).toBeNull()
  })
})
