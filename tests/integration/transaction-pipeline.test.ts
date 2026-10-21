/**
 * `db.transaction()` — writes inside it must behave like `collection.*` writes.
 *
 * The transaction context used to hand callers the raw adapter context, so a
 * write made inside a transaction skipped validation, never reached a plugin
 * (a document created there was invisible to `match()`), and emitted no change
 * event (so `db.on()` and reactive queries ignored it).
 *
 * Hooks and events are dispatched *after* the commit. That is the only safe
 * point — an after-hook writes through the adapter, and awaiting an unrelated
 * transaction inside an IndexedDB one lets the outer transaction auto-commit —
 * and it gives the right abort semantics: a rolled-back transaction leaves
 * neither an index entry nor an event behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Database } from "../../src/database"
import { RecordNotFoundError, ValidationError } from "../../src/errors"
import { ftsPlugin } from "../../src/plugins/fts/index"
import type { ChangeEvent, CtroDBPlugin, StorageAdapter } from "../../src/types"

const schema = {
  version: 1,
  collections: {
    docs: {
      fields: {
        title: { type: "string", required: true },
        rank: { type: "number", default: 0 },
      },
      searchable: ["title"],
    },
  },
} as const

interface Doc {
  id: string
  title: string
  rank?: number
}

const open: Database[] = []

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
})

async function makeDb(
  adapter: "memory" | "indexeddb" | StorageAdapter,
  plugins: CtroDBPlugin[] = [],
): Promise<Database> {
  const db = new Database({
    name: `tx-${Math.random().toString(36).slice(2)}`,
    adapter,
    schema: schema as never,
    plugins,
  })
  await db.connect()
  open.push(db)
  return db
}

const docs = (db: Database) => db.collection<Doc>("docs")

describe.each(["memory", "indexeddb"] as const)("transaction pipeline (%s)", (adapterName) => {
  it("returns the callback's value and commits its writes", async () => {
    const db = await makeDb(adapterName)
    const result = await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "a", title: "one" })
      await tx.collection("docs").create({ id: "b", title: "two" })
      return "done"
    })

    expect(result).toBe("done")
    expect((await docs(db).getAll()).map((doc) => doc.id)).toEqual(["a", "b"])
  })

  it("generates an id when the record has none", async () => {
    const db = await makeDb(adapterName)
    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ title: "no id" })
    })

    const [record] = await docs(db).getAll()
    expect(typeof record?.id).toBe("string")
    expect(record?.id.length).toBeGreaterThan(0)
  })

  it("applies schema defaults", async () => {
    const db = await makeDb(adapterName)
    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "a", title: "one" })
    })

    expect((await docs(db).get("a"))?.rank).toBe(0)
  })

  it("validates, and writes nothing when a record is invalid", async () => {
    const db = await makeDb(adapterName)

    await expect(
      db.transaction(async (tx) => {
        await tx.collection("docs").create({ id: "ok", title: "fine" })
        await tx.collection("docs").create({ id: "bad" })
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(await docs(db).count()).toBe(0)
  })

  it("validates an update against the merged record", async () => {
    const db = await makeDb(adapterName)
    await docs(db).create({ id: "a", title: "one" })

    await expect(
      db.transaction(async (tx) => {
        await tx.collection("docs").update("a", { title: 42 } as never)
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect((await docs(db).get("a"))?.title).toBe("one")
  })

  it("throws RecordNotFoundError when updating a missing record", async () => {
    const db = await makeDb(adapterName)
    await expect(
      db.transaction(async (tx) => {
        await tx.collection("docs").update("missing", { title: "x" })
      }),
    ).rejects.toBeInstanceOf(RecordNotFoundError)
  })

  it("emits one change event per committed write, in order", async () => {
    const db = await makeDb(adapterName)
    const events: ChangeEvent[] = []
    db.on((event) => events.push(event))

    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "a", title: "one" })
      await tx.collection("docs").update("a", { title: "two" })
      await tx.collection("docs").delete("a")
    })

    expect(events.map((event) => event.type)).toEqual(["create", "update", "delete"])
    expect(events[0]?.collection).toBe("docs")
    // The `oldRecord` an update and a delete report must be the pre-write row,
    // otherwise a subscriber cannot tell what changed.
    expect((events[1]?.oldRecord as Doc).title).toBe("one")
    expect((events[1]?.record as Doc).title).toBe("two")
    expect((events[2]?.oldRecord as Doc).title).toBe("two")
  })

  it("emits nothing and indexes nothing when the transaction aborts", async () => {
    const db = await makeDb(adapterName, [ftsPlugin()])
    const events: ChangeEvent[] = []
    db.on((event) => events.push(event))

    await expect(
      db.transaction(async (tx) => {
        await tx.collection("docs").create({ id: "gone", title: "phantom" })
        throw new Error("abort")
      }),
    ).rejects.toThrow("abort")

    expect(events).toEqual([])
    expect(await docs(db).count()).toBe(0)
    // The full-text index is derived data: a rolled-back row must not leave a
    // posting behind, or `match()` would return a document that does not exist.
    expect(await docs(db).query().match("phantom").fetch()).toEqual([])
  })

  it("makes transactional writes searchable with ftsPlugin()", async () => {
    const db = await makeDb(adapterName, [ftsPlugin()])

    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "a", title: "alpha beta" })
      await tx.collection("docs").create({ id: "b", title: "gamma" })
    })

    expect((await docs(db).query().match("alpha").fetch()).map((doc) => doc.id)).toEqual(["a"])
    expect(await docs(db).query().match("alpha gamma").fetch()).toEqual([])
  })

  it("reindexes a transactional update and drops the old tokens", async () => {
    const db = await makeDb(adapterName, [ftsPlugin()])
    await docs(db).create({ id: "a", title: "before" })

    await db.transaction(async (tx) => {
      await tx.collection("docs").update("a", { title: "after" })
    })

    expect(await docs(db).query().match("before").fetch()).toEqual([])
    expect((await docs(db).query().match("after").fetch()).map((doc) => doc.id)).toEqual(["a"])
  })

  it("removes postings for a transactional delete", async () => {
    const db = await makeDb(adapterName, [ftsPlugin()])
    await docs(db).create({ id: "a", title: "transient" })

    await db.transaction(async (tx) => {
      await tx.collection("docs").delete("a")
    })

    expect(await docs(db).query().match("transient").fetch()).toEqual([])
  })

  it("runs before- and after-hooks like the collection API", async () => {
    const calls: string[] = []
    const plugin: CtroDBPlugin = {
      name: "spy",
      onBeforeCreate(_collection, data) {
        calls.push("beforeCreate")
        return { ...(data as Doc), title: "rewritten" }
      },
      onAfterCreate() {
        calls.push("afterCreate")
      },
      onBeforeUpdate() {
        calls.push("beforeUpdate")
      },
      onAfterUpdate(_collection, _id, _record, oldRecord) {
        calls.push(`afterUpdate:${(oldRecord as Doc).title}`)
      },
      onBeforeDelete() {
        calls.push("beforeDelete")
      },
      onAfterDelete() {
        calls.push("afterDelete")
      },
    }

    const db = await makeDb(adapterName, [plugin])
    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "a", title: "original" })
      await tx.collection("docs").update("a", { rank: 1 })
      await tx.collection("docs").delete("a")
    })

    // Before-hooks are part of the adapter transaction. After-hooks run only
    // after it commits, in the original write order: all data operations have
    // finished before plugins start their non-transactional side effects.
    expect(calls).toEqual([
      "beforeCreate",
      "beforeUpdate",
      "beforeDelete",
      "afterCreate",
      "afterUpdate:rewritten",
      "afterDelete",
    ])
  })

  it("keeps the commit when an after-hook fails, and reports it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const plugin: CtroDBPlugin = {
      name: "broken",
      onAfterCreate() {
        throw new Error("hook exploded")
      },
    }

    const db = await makeDb(adapterName, [plugin])
    // The data is already durable: rejecting would report a successful commit
    // as a failure and invite a retry that duplicates it.
    await expect(
      db.transaction(async (tx) => {
        await tx.collection("docs").create({ id: "a", title: "kept" })
      }),
    ).resolves.toBeUndefined()

    expect(await docs(db).count()).toBe(1)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it("reads see uncommitted writes inside the transaction", async () => {
    const db = await makeDb(adapterName)
    const seen = await db.transaction(async (tx) => {
      const collection = tx.collection("docs")
      await collection.create({ id: "a", title: "visible" })
      const found = await collection.findById("a")
      const all = await collection.findAll()
      return { found, all }
    })

    expect((seen.found as Doc).title).toBe("visible")
    expect(seen.all).toHaveLength(1)
  })
})

describe("transaction pipeline details", () => {
  it("dispatches events once per write, not once per hook-runner", async () => {
    const db = await makeDb("memory")
    const seen: string[] = []
    db.on((event) => seen.push(event.type))
    await db.collection("docs").create({ id: "outside", title: "plain create" })
    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "inside", title: "transactional" })
    })
    expect(seen).toEqual(["create", "create"])
  })

  it("does not reuse a previous flush's writes", async () => {
    const db = await makeDb("memory")
    const seen: string[] = []
    db.on((event) => seen.push(event.type))

    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "a", title: "one" })
    })
    await db.transaction(async (tx) => {
      await tx.collection("docs").create({ id: "b", title: "two" })
    })

    expect(seen).toEqual(["create", "create"])
  })

  it("keeps concurrent transactions independent", async () => {
    const db = await makeDb("memory")
    const seen: string[] = []
    db.on((event) => seen.push(event.recordId as string))

    await Promise.all([
      db.transaction(async (tx) => {
        await tx.collection("docs").create({ id: "a", title: "one" })
      }),
      db.transaction(async (tx) => {
        await tx.collection("docs").create({ id: "b", title: "two" })
      }),
    ])

    expect(seen.sort()).toEqual(["a", "b"])
  })
})
