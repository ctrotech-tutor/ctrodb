/**
 * `count()` used to materialise every row just to read `.length`:
 * `Collection.count()` copied the whole collection through `findAll()`, and
 * `QueryBuilder.count()` additionally wrapped every copy in a `Model` Proxy and
 * threw them all away. On 10,000 rows that was ~0.37 ms per call.
 *
 * These tests pin both the optimisation and its safety:
 * - adapters get an optional `count()` (third-party adapters that lack it still
 *   work through the old `findAll()` path),
 * - a query count must still respect `where`, `limit`, `offset` and `sort`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryAdapter } from "../../src/adapter/memory"
import { Database } from "../../src/database"

const schema = {
  version: 1,
  collections: {
    items: {
      fields: { name: { type: "string" }, score: { type: "number" } },
      indexes: [{ field: "score" }],
    },
  },
}

let db: Database

beforeEach(async () => {
  db = new Database({ name: `count-${Math.random()}`, adapter: "memory", schema: schema as never })
  await db.connect()
  const items = db.collection<{ id: string; name: string; score: number }>("items")
  for (let i = 0; i < 25; i++) {
    await items.create({ id: `i${i}`, name: `n${i}`, score: i })
  }
})

describe("count()", () => {
  it("counts rows without copying the collection", async () => {
    const items = db.collection<{ id: string; name: string; score: number }>("items")
    const adapter = db._getAdapter() as unknown as MemoryAdapter
    const findAll = vi.spyOn(adapter, "findAll")

    expect(await items.count()).toBe(25)
    expect(findAll).not.toHaveBeenCalled()
  })

  it("delegates an unfiltered query count to the adapter", async () => {
    const items = db.collection<{ id: string; name: string; score: number }>("items")
    const adapter = db._getAdapter() as unknown as MemoryAdapter
    const findAll = vi.spyOn(adapter, "findAll")

    expect(await items.query().count()).toBe(25)
    expect(findAll).not.toHaveBeenCalled()
  })

  it("counts a filtered query without building models", async () => {
    const items = db.collection<{ id: string; name: string; score: number }>("items")

    expect(await items.query().where("score", ">=", 20).count()).toBe(5)

    const toModels = vi.spyOn(items, "_toModels")
    await items.query().where("score", ">=", 20).count()
    expect(toModels).not.toHaveBeenCalled()
  })

  it("respects limit, offset and sort", async () => {
    const items = db.collection<{ id: string; name: string; score: number }>("items")

    expect(await items.query().limit(10).count()).toBe(10)
    expect(await items.query().offset(20).count()).toBe(5)
    expect(await items.query().sort({ score: "desc" }).limit(3).count()).toBe(3)
  })

  it("works for adapters that do not implement count()", async () => {
    const legacy = new MemoryAdapter()
    // Simulate a third-party adapter written against the previous interface.
    Object.defineProperty(legacy, "count", { value: undefined })

    const local = new Database({
      name: `count-legacy-${Math.random()}`,
      adapter: legacy as never,
      schema: schema as never,
    })
    await local.connect()
    const items = local.collection<{ id: string; name: string; score: number }>("items")
    await items.create({ id: "a", name: "a", score: 1 })

    expect(await items.count()).toBe(1)
    expect(await items.query().count()).toBe(1)
    await local.disconnect()
  })

  it("stays correct after deletes", async () => {
    const items = db.collection<{ id: string; name: string; score: number }>("items")
    await items.delete("i0")
    await items.deleteMany(["i1", "i2"])

    expect(await items.count()).toBe(22)
    expect(await items.query().count()).toBe(22)
  })
})
