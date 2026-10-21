/**
 * `createMany()` — batch inserts.
 *
 * A batch has to be three things at once, and the tests are organised around
 * that: **correct** (same observable behaviour as N `create()` calls: same
 * events, same hooks, same validation), **atomic** (a rejected batch writes
 * nothing, on both adapters), and **actually faster** (one adapter operation
 * instead of N — which is where the speed comes from, not from skipping work).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryAdapter } from "../../src/adapter/memory"
import { Database } from "../../src/database"
import { ValidationError } from "../../src/errors"
import { ftsPlugin } from "../../src/plugins/fts/index"
import type { ChangeEvent, CtroDBPlugin, StorageAdapter } from "../../src/types"

const schema = {
  version: 1,
  collections: {
    docs: {
      fields: {
        title: { type: "string", required: true },
        body: { type: "string" },
        rank: { type: "number", default: 0 },
        slug: { type: "string", unique: true },
      },
      indexes: [{ field: "rank" }],
      searchable: ["title", "body"],
    },
  },
} as const

const open: Database[] = []

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
})

async function makeDb(
  adapter: "memory" | "indexeddb" | StorageAdapter,
  plugins: CtroDBPlugin[] = [],
): Promise<Database> {
  const db = new Database({
    name: `create-many-${Math.random().toString(36).slice(2)}`,
    adapter,
    schema: schema as never,
    plugins,
  })
  await db.connect()
  open.push(db)
  return db
}

const docs = (db: Database) =>
  db.collection<{
    id: string
    title: string
    body?: string
    rank?: number
    slug?: string
  }>("docs")

describe.each(["memory", "indexeddb"] as const)("createMany (%s)", (adapterName) => {
  it("writes every record and returns models in input order", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)

    const models = await collection.createMany([
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ])

    expect(models.map((model) => model.title)).toEqual(["first", "second", "third"])
    expect(models.every((model) => typeof model.id === "string" && model.id.length > 0)).toBe(true)
    expect(await collection.count()).toBe(3)

    // The returned models are real models, not plain records.
    const stored = await collection.get(models[0]?.id as string)
    expect(stored?.title).toBe("first")
  })

  it("honours provided ids and applies defaults", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)

    const models = await collection.createMany([
      { id: "a", title: "alpha" },
      { id: "b", title: "beta" },
    ])

    expect(models.map((model) => model.id)).toEqual(["a", "b"])
    // `rank` has a default, so it exists even though it was omitted.
    expect(models.map((model) => model.rank)).toEqual([0, 0])
  })

  it("emits one create event per record, exactly like create()", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)

    const events: ChangeEvent[] = []
    db.on((event) => events.push(event))

    await collection.createMany([{ title: "one" }, { title: "two" }])

    expect(events).toHaveLength(2)
    expect(events.map((event) => event.type)).toEqual(["create", "create"])
    expect(events.map((event) => (event.record as { title: string }).title)).toEqual(["one", "two"])
    expect(events.map((event) => event.collection)).toEqual(["docs", "docs"])
    expect(new Set(events.map((event) => event.recordId)).size).toBe(2)
  })

  it("notifies collection listeners too", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)

    const seen: string[] = []
    collection.onChange((event) => seen.push(String(event.recordId)))

    const models = await collection.createMany([{ title: "x" }, { title: "y" }])
    expect(seen.sort()).toEqual(models.map((model) => String(model.id)).sort())
  })

  it("returns an empty array and writes nothing for an empty batch", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)

    const events: ChangeEvent[] = []
    db.on((event) => events.push(event))

    expect(await collection.createMany([])).toEqual([])
    expect(await collection.count()).toBe(0)
    expect(events).toEqual([])
  })
})

describe.each(["memory", "indexeddb"] as const)("createMany atomicity (%s)", (adapterName) => {
  it("writes nothing when a record in the batch is invalid", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)
    await collection.create({ title: "existing" })

    await expect(
      collection.createMany([
        { title: "fine" },
        // `title` is required.
        { body: "no title" } as unknown as { title: string },
        { title: "also fine" },
      ]),
    ).rejects.toBeInstanceOf(ValidationError)

    // Not even the records before the invalid one were written.
    expect(await collection.count()).toBe(1)
  })

  it("rejects an invalid batch without running any before-hook", async () => {
    // Validation happens for the whole batch before the first hook, so a bad
    // record cannot leave hook side effects from its neighbours behind.
    const hooked: string[] = []
    const plugin: CtroDBPlugin = {
      name: "spy",
      onBeforeCreate(_collection, data) {
        hooked.push((data as { title: string }).title)
        return data
      },
    }

    const db = await makeDb(adapterName, [plugin])
    const collection = docs(db)

    await expect(
      collection.createMany([
        { title: "fine" },
        { body: "no title" } as unknown as { title: string },
      ]),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(hooked).toEqual([])
    expect(await collection.count()).toBe(0)
  })

  it("writes nothing when an id is already taken, and names the record", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)
    await collection.create({ id: "taken", title: "original" })

    const error = await collection
      .createMany([
        { id: "fresh", title: "fresh" },
        { id: "taken", title: "clash" },
      ])
      .catch((caught: Error) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("taken")
    expect((error as Error).message).toContain("already exists")

    // The first record must not have been written.
    expect(await collection.count()).toBe(1)
    expect(await collection.get("fresh")).toBeUndefined()
    expect((await collection.get("taken"))?.title).toBe("original")
  })

  it("rejects a batch with the same id twice, before touching the adapter", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)
    const adapter = db._getAdapter()
    const createMany = vi.spyOn(adapter, "createMany")

    await expect(
      collection.createMany([
        { id: "dup", title: "one" },
        { id: "dup", title: "two" },
      ]),
    ).rejects.toThrow(/same id twice/)

    expect(createMany).not.toHaveBeenCalled()
    expect(await collection.count()).toBe(0)
  })

  it("writes nothing when a unique field collides inside the batch", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)

    await expect(
      collection.createMany([
        { title: "one", slug: "same" },
        { title: "two", slug: "same" },
      ]),
    ).rejects.toThrow(/unique constraint/i)

    expect(await collection.count()).toBe(0)
  })

  it("writes nothing when a unique field collides with an existing row", async () => {
    const db = await makeDb(adapterName)
    const collection = docs(db)
    await collection.create({ title: "original", slug: "taken" })

    await expect(
      collection.createMany([
        { title: "new", slug: "free" },
        { title: "clash", slug: "taken" },
      ]),
    ).rejects.toThrow(/unique constraint/i)

    expect(await collection.count()).toBe(1)
  })

  it("is atomic when the adapter rejects part-way through", async () => {
    // Force the failure at the adapter level, past validation and hooks, so the
    // rollback rather than the pre-checks is what is being tested.
    const db = await makeDb(adapterName)
    const collection = docs(db)
    const adapter = db._getAdapter()
    const originalCreateMany = adapter.createMany?.bind(adapter)

    if (!originalCreateMany) throw new Error("expected the adapter to implement createMany")

    let calls = 0
    adapter.createMany = async (name: string, records: unknown[]) => {
      calls++
      // Fail the second batch with a non-constraint error.
      if (calls === 2) throw new Error("disk on fire")
      return originalCreateMany(name, records)
    }

    await collection.createMany([{ title: "kept" }])
    await expect(collection.createMany([{ title: "dropped" }])).rejects.toThrow("disk on fire")
    expect(await collection.count()).toBe(1)
  })
})

describe("createMany hooks and plugins", () => {
  it("runs onBeforeCreate per record, and its result is what is stored", async () => {
    const seen: string[] = []
    const plugin: CtroDBPlugin = {
      name: "recorder",
      onBeforeCreate(_collection, data) {
        const record = data as { title: string }
        seen.push(record.title)
        return { ...record, title: record.title.toUpperCase() }
      },
    }

    const db = await makeDb("memory", [plugin])
    const models = await docs(db).createMany([{ title: "one" }, { title: "two" }])

    expect(seen).toEqual(["one", "two"])
    expect(models.map((model) => model.title)).toEqual(["ONE", "TWO"])
    expect((await docs(db).get(models[0]?.id as string))?.title).toBe("ONE")
  })

  it("calls onAfterCreate per record for plugins without the bulk hook", async () => {
    const calls: string[] = []
    const plugin: CtroDBPlugin = {
      name: "singular-only",
      onAfterCreate(_collection, record) {
        calls.push((record as { title: string }).title)
      },
    }

    const db = await makeDb("memory", [plugin])
    await docs(db).createMany([{ title: "a" }, { title: "b" }, { title: "c" }])

    expect(calls).toEqual(["a", "b", "c"])
  })

  it("calls onAfterCreateMany once instead of per record", async () => {
    const bulk: unknown[][] = []
    const single: string[] = []
    const plugin: CtroDBPlugin = {
      name: "bulk-capable",
      onAfterCreate(_collection, record) {
        single.push((record as { title: string }).title)
      },
      onAfterCreateMany(_collection, records) {
        bulk.push(records)
      },
    }

    const db = await makeDb("memory", [plugin])
    await docs(db).createMany([{ title: "a" }, { title: "b" }])

    expect(bulk).toHaveLength(1)
    expect(bulk[0]).toHaveLength(2)
    // The singular hook must not fire as well: an index would be written twice.
    expect(single).toEqual([])
  })

  it("dispatches bulk and singular plugins side by side", async () => {
    const bulk: number[] = []
    const single: string[] = []

    const bulkPlugin: CtroDBPlugin = {
      name: "bulk",
      onAfterCreateMany(_collection, records) {
        bulk.push((records as unknown[]).length)
      },
    }
    const singlePlugin: CtroDBPlugin = {
      name: "single",
      onAfterCreate(_collection, record) {
        single.push((record as { title: string }).title)
      },
    }

    const db = await makeDb("memory", [bulkPlugin, singlePlugin])
    await docs(db).createMany([{ title: "a" }, { title: "b" }])

    expect(bulk).toEqual([2])
    expect(single).toEqual(["a", "b"])
  })
})

describe("createMany with the full-text index", () => {
  it("indexes the whole batch, and the records are searchable", async () => {
    const db = await makeDb("memory", [ftsPlugin()])
    const collection = docs(db)

    const models = await collection.createMany([
      { title: "Alpha One", body: "shared token" },
      { title: "Beta Two", body: "shared token" },
      { title: "Gamma Three", body: "other" },
    ])

    expect((await collection.query().match("shared").fetch()).length).toBe(2)
    expect((await collection.query().match("alpha").fetch()).map((m) => m.id)).toEqual([
      models[0]?.id,
    ])
    expect(await collection.query().match("missing").fetch()).toEqual([])
  })

  it("does not duplicate postings when a batch is indexed twice", async () => {
    const db = await makeDb("memory", [ftsPlugin()])
    const collection = docs(db)
    const adapter = db._getAdapter()

    await collection.createMany([{ id: "x", title: "repeated words" }])

    const before = (await adapter.findAll("_ctrodb_fts")).length
    // Re-index the same records directly: a retry, a sync replay or a rebuild
    // must not grow the index.
    const indexer = new (await import("../../src/plugins/fts/indexer")).FTSIndexer(adapter)
    const records = await adapter.findAll("docs")
    await indexer.indexRecords("docs", records as Record<string, unknown>[], ["title", "body"])

    expect((await adapter.findAll("_ctrodb_fts")).length).toBe(before)
  })
})

describe("createMany without the adapter capability", () => {
  it("falls back to one create per record", async () => {
    const adapter = new MemoryAdapter()
    Object.defineProperty(adapter, "createMany", { value: undefined })

    const db = await makeDb(adapter as StorageAdapter)
    const models = await docs(db).createMany([{ title: "a" }, { title: "b" }])

    expect(models.map((model) => model.title)).toEqual(["a", "b"])
    expect(await docs(db).count()).toBe(2)
  })
})

describe("both shipped adapters implement batching", () => {
  it.each(["memory", "indexeddb"] as const)("%s provides createMany", async (adapterName) => {
    // The speed-up comes from the adapter, not from this layer: the fallback
    // keeps working but pays one operation per record, so the capability has to
    // exist on every adapter we ship.
    const db = await makeDb(adapterName)
    expect(typeof db._getAdapter().createMany).toBe("function")
  })
})

describe("createMany cost", () => {
  it("uses one adapter call for the whole batch", async () => {
    const db = await makeDb("memory")
    const collection = docs(db)
    const adapter = db._getAdapter()

    const createMany = vi.spyOn(adapter, "createMany")
    const create = vi.spyOn(adapter, "create")

    await collection.createMany(Array.from({ length: 50 }, (_, i) => ({ title: `row ${i}` })))

    expect(createMany).toHaveBeenCalledTimes(1)
    expect(createMany.mock.calls[0]?.[1]).toHaveLength(50)
    expect(create).not.toHaveBeenCalled()
  })
})
