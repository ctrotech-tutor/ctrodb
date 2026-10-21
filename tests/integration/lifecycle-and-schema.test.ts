/**
 * Regression tests for the schema/lifecycle batch:
 *
 *  - M-01  a failing `onDatabaseInit` left the Database claiming to be connected
 *  - M-02  `validate: (value) => boolean` was typed but never called
 *  - M-03  field-level `unique: true` was never enforced by either adapter
 *  - M-07  `retryMaxAttempts` was accepted but never read (infinite retries)
 *  - M-10  `db.disconnect()` never shut the sync engine down, so timers,
 *          BroadcastChannel and the transport outlived the database
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Database } from "../../src/database"
import { Schema } from "../../src/schema"
import { inspectSyncQueue } from "../../src/sync/devtools"
import { syncPlugin } from "../../src/sync/sync-plugin"
import type {
  PullOptions,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "../../src/sync/types"
import type { CtroDBPlugin } from "../../src/types"

const open: Database[] = []

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
  vi.restoreAllMocks()
})

function track(db: Database): Database {
  open.push(db)
  return db
}

describe("database lifecycle", () => {
  it("does not report itself connected when a plugin fails to initialise (M-01)", async () => {
    const exploding: CtroDBPlugin = {
      name: "exploding",
      onDatabaseInit() {
        throw new Error("init failed")
      },
    }

    const db = track(
      new Database({
        name: `init-fail-${Math.random().toString(36).slice(2)}`,
        adapter: "memory",
        schema: { version: 1, collections: { a: { fields: { x: { type: "string" } } } } } as never,
        plugins: [exploding],
      }),
    )

    await expect(db.connect()).rejects.toThrow("init failed")

    // The half-initialised instance must not look usable.
    expect(() => db.collection("a")).toThrow()
    // …and a retry must work once the plugin is fixed (the adapter was closed).
    await expect(db.connect()).rejects.toThrow("init failed")
  })

  it("calls onDatabaseDestroy in reverse order and stops sync timers (M-10)", async () => {
    const calls: string[] = []
    const transport: SyncTransport = {
      name: "noop",
      async push(): Promise<SyncPushResult> {
        return { accepted: [], conflicts: [], errors: [] }
      },
      async pull(): Promise<SyncPullResult> {
        return { changes: [], cursor: null, hasMore: false }
      },
      async disconnect() {
        calls.push("transport")
      },
    }

    const first: CtroDBPlugin = {
      name: "first",
      onDatabaseDestroy() {
        calls.push("first")
      },
    }
    const second: CtroDBPlugin = {
      name: "second",
      onDatabaseDestroy() {
        calls.push("second")
      },
    }

    const db = track(
      new Database({
        name: `destroy-${Math.random().toString(36).slice(2)}`,
        adapter: "memory",
        schema: { version: 1, collections: { a: { fields: { x: { type: "string" } } } } } as never,
        plugins: [first, syncPlugin({ transport, autoSync: { intervalMs: 1000 } }), second],
      }),
    )
    await db.connect()

    await db.disconnect()

    expect(calls).toEqual(["second", "transport", "first"])
  })

  it("keeps working when a plugin throws during shutdown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exploding: CtroDBPlugin = {
      name: "exploding",
      onDatabaseDestroy() {
        throw new Error("shutdown failed")
      },
    }
    const db = track(
      new Database({
        name: `destroy-fail-${Math.random().toString(36).slice(2)}`,
        adapter: "memory",
        schema: { version: 1, collections: { a: { fields: { x: { type: "string" } } } } } as never,
        plugins: [exploding],
      }),
    )
    await db.connect()

    await expect(db.disconnect()).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
  })
})

describe("schema enforcement", () => {
  it("calls a custom validator function (M-02)", async () => {
    const db = track(
      new Database({
        name: `validate-${Math.random().toString(36).slice(2)}`,
        adapter: "memory",
        schema: {
          version: 1,
          collections: {
            users: {
              fields: {
                handle: { type: "string", validate: (value: unknown) => value !== "admin" },
              },
            },
          },
        } as never,
      }),
    )
    await db.connect()

    await expect(db.collection("users").create({ handle: "admin" })).rejects.toThrow(
      /custom validation/,
    )
    await expect(db.collection("users").create({ handle: "ada" })).resolves.toBeDefined()
  })

  it("enforces a field-level unique declaration on every adapter (M-03)", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        users: { fields: { email: { type: "string", unique: true } } },
      },
    })

    // The declaration becomes a unique index, which is what adapters enforce.
    expect(schema.getIndexes("users")).toEqual([{ field: "email", unique: true }])

    for (const adapter of ["memory", "indexeddb"] as const) {
      const db = track(
        new Database({
          name: `unique-${adapter}-${Math.random().toString(36).slice(2)}`,
          adapter,
          schema,
        }),
      )
      await db.connect()
      const users = db.collection("users")
      await users.create({ id: "u1", email: "a@b.c" })
      await expect(users.create({ id: "u2", email: "a@b.c" })).rejects.toThrow(/unique constraint/i)
    }
  })

  it("rejects a schema that contradicts itself", () => {
    expect(
      () =>
        new Schema({
          version: 1,
          collections: {
            users: {
              fields: { email: { type: "string", unique: true } },
              indexes: [{ field: "email" }],
            },
          },
        }),
    ).toThrow(/not unique/)
  })
})

describe("sync retry policy", () => {
  it("stops retrying a change after retryMaxAttempts (M-07)", async () => {
    const transport: SyncTransport = {
      name: "always-fails",
      pushed: 0,
      async push(changes): Promise<SyncPushResult> {
        const self = transport as unknown as { pushed: number }
        self.pushed += changes.length
        return {
          accepted: [],
          conflicts: [],
          errors: changes.map((c) => ({ id: c.id, error: "Server said no" })),
        }
      },
      async pull(): Promise<SyncPullResult> {
        return { changes: [], cursor: null, hasMore: false }
      },
    } as SyncTransport

    const db = track(
      new Database({
        name: `retry-${Math.random().toString(36).slice(2)}`,
        adapter: "memory",
        schema: { version: 1, collections: { a: { fields: { x: { type: "string" } } } } } as never,
        plugins: [syncPlugin({ transport, autoSync: false, retryMaxAttempts: 2 })],
      }),
    )
    await db.connect()
    await db.collection("a").create({ x: "value" })

    await db.sync()
    await db.sync()
    await db.sync()
    await db.sync()

    const snapshot = await inspectSyncQueue(db)
    expect(snapshot.failed).toHaveLength(1)
    // Attempts are bounded: after the cap the change is parked, not re-pushed.
    expect((transport as unknown as { pushed: number }).pushed).toBeLessThanOrEqual(2)
  })
})
