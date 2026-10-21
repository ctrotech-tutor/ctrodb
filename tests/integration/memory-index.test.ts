/**
 * The memory adapter used to ignore its own index structures: `scanIndex()`
 * took a full copy of the collection and filtered it, so declaring an index made
 * queries *slower* (measured 2.6x on 20k rows) instead of faster.
 *
 * These tests pin the two things that matter now that real buckets exist:
 *
 * 1. **Correctness** — an indexed query must return exactly what a full scan
 *    returns, after every kind of write (create, update, delete, deleteMany,
 *    transaction rollback).
 * 2. **Safety** — a value that is not a valid index key (boolean, `null`,
 *    object, array) must force the scan path rather than silently hiding rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Database } from "../../src/database"

const schema = {
  version: 1,
  collections: {
    items: {
      fields: {
        name: { type: "string" },
        score: { type: "number" },
        group: { type: "string" },
        flag: { type: "boolean" },
      },
      indexes: [{ field: "score" }, { field: "group" }],
    },
  },
} as const

let db: Database

beforeEach(async () => {
  db = new Database({
    name: `mem-index-${Math.random()}`,
    adapter: "memory",
    schema: schema as never,
  })
  await db.connect()
})

afterEach(async () => {
  await db.disconnect()
})

describe("memory adapter indexes", () => {
  it("returns the same rows as a full scan", async () => {
    const items = db.collection("items")
    for (let i = 0; i < 50; i++) {
      await items.create({ name: `n${i}`, score: i, group: `g${i % 5}`, flag: i % 2 === 0 })
    }

    const viaIndex = await items.query().where("score", ">=", 40).fetch()
    const expected = (await items.getAll())
      .filter((record) => Number(record.score) >= 40)
      .map((record) => String(record.id))
      .sort()

    expect(viaIndex.map((record) => String(record.id)).sort()).toEqual(expected)
  })

  it("uses exclusive and inclusive bounds on a cached sorted range index", async () => {
    const items = db.collection("items")
    for (const score of [10, 20, 30, 40]) {
      await items.create({ id: `score-${score}`, name: `n${score}`, score, group: "g" })
    }

    // First range query constructs the sorted-key cache.
    expect(
      (await items.query().where("score", ">", 20).fetch()).map((r) => r.score).sort(),
    ).toEqual([30, 40])
    expect(
      (await items.query().where("score", "<=", 30).fetch()).map((r) => r.score).sort(),
    ).toEqual([10, 20, 30])

    // Creating and removing distinct keys must invalidate the cached key list.
    await items.create({ id: "score-25", name: "n25", score: 25, group: "g" })
    expect(
      (await items.query().where("score", ">", 20).fetch()).map((r) => r.score).sort(),
    ).toEqual([25, 30, 40])

    await items.update("score-40", { score: 35 })
    expect(
      (await items.query().where("score", ">", 20).fetch()).map((r) => r.score).sort(),
    ).toEqual([25, 30, 35])

    await items.delete("score-30")
    expect(
      (await items.query().where("score", ">", 20).fetch()).map((r) => r.score).sort(),
    ).toEqual([25, 35])
  })

  it("follows updates that move a record between buckets", async () => {
    const items = db.collection("items")
    const created = await items.create({ name: "mover", score: 1, group: "alpha" })

    await created.update({ group: "beta", score: 2 })

    const alpha = await items.query().where("group", "==", "alpha").fetch()
    const beta = await items.query().where("group", "==", "beta").fetch()
    expect(alpha).toHaveLength(0)
    expect(beta.map((r) => String(r.id))).toEqual([String(created.id)])

    // The old key must not survive in the index either.
    const low = await items.query().where("score", "==", 1).fetch()
    const high = await items.query().where("score", "==", 2).fetch()
    expect(low).toHaveLength(0)
    expect(high).toHaveLength(1)
  })

  it("drops deleted records from the index", async () => {
    const items = db.collection("items")
    const a = await items.create({ name: "a", score: 7, group: "x" })
    const b = await items.create({ name: "b", score: 7, group: "x" })

    await a.delete()
    expect((await items.query().where("score", "==", 7).fetch()).map((r) => String(r.id))).toEqual([
      String(b.id),
    ])

    await items.deleteMany([b.id])
    expect(await items.query().where("score", "==", 7).fetch()).toEqual([])
    expect(await items.query().where("group", "==", "x").fetch()).toEqual([])
  })

  it("stays consistent when a transaction rolls back", async () => {
    const items = db.collection("items")
    const record = await items.create({ name: "kept", score: 10, group: "stable" })

    await expect(
      db.transaction(async (ctx) => {
        await ctx.collection("items").update(record.id, { score: 99, group: "moved" })
        throw new Error("rollback")
      }),
    ).rejects.toThrow("rollback")

    expect((await items.query().where("score", "==", 10).fetch()).map((r) => String(r.id))).toEqual(
      [String(record.id)],
    )
    expect(await items.query().where("score", "==", 99).fetch()).toEqual([])
    expect((await items.query().where("group", "==", "stable").fetch()).length).toBe(1)
    expect(await items.query().where("group", "==", "moved").fetch()).toEqual([])
  })

  it("falls back to a scan when an indexed value is not a valid key", async () => {
    // `flag` is a boolean: not an IndexedDB key, so it must never be indexed.
    const unindexableSchema = {
      version: 1,
      collections: {
        things: {
          fields: { flag: { type: "boolean" } },
          indexes: [{ field: "flag" }],
        },
      },
    } as const

    const local = new Database({
      name: `mem-index-unindexable-${Math.random()}`,
      adapter: "memory",
      schema: unindexableSchema as never,
    })
    await local.connect()

    try {
      const things = local.collection("things")
      await things.create({ id: "t1", flag: true })
      await things.create({ id: "t2", flag: false })

      const result = await things.query().where("flag", "==", true).fetch()
      expect(result.map((r) => String(r.id))).toEqual(["t1"])

      expect(await scanEqualsFor(local, "things", "flag", true)).toEqual(["t1"])
    } finally {
      await local.disconnect()
    }
  })

  it("serves an equality query without scanning the collection", async () => {
    const items = db.collection("items")
    for (let i = 0; i < 100; i++) {
      await items.create({ name: `n${i}`, score: i, group: `g${i % 5}` })
    }

    const adapter = db._getAdapter() as unknown as {
      findAll(collection: string): Promise<unknown[]>
    }
    const findAll = vi.spyOn(adapter, "findAll")

    const result = await items.query().where("score", "==", 42).fetch()
    expect(result).toHaveLength(1)

    // The whole point of an index: no full copy of the collection. Before the
    // fix `scanIndex` called findAll() on every indexed query.
    expect(findAll).not.toHaveBeenCalled()
    expect((await items.query().where("name", "==", "n42").fetch()).length).toBe(1)
    expect(findAll).toHaveBeenCalled()
  })

  it("rebuilds buckets when an adapter reconnects over existing rows", async () => {
    const items = db.collection("items")
    await items.create({ name: "kept", score: 5, group: "g" })

    // Reconnecting must not leave the index empty for rows already in memory.
    await db.connect()

    expect((await items.query().where("score", "==", 5).fetch()).map((r) => r.name)).toEqual([
      "kept",
    ])
  })

  it("keeps the non-indexed path identical", async () => {
    const items = db.collection("items")
    for (let i = 0; i < 20; i++) await items.create({ name: `n${i}`, score: i, group: "g0" })

    // `name` has no index: the planner must full-scan and still be correct.
    const byName = await items.query().where("name", "==", "n7").fetch()
    expect(byName.map((r) => r.name)).toEqual(["n7"])
  })
})

async function scanEqualsFor(
  database: Database,
  collection: string,
  field: string,
  value: unknown,
): Promise<string[]> {
  const all = await database.collection<Record<string, unknown>>(collection).getAll()
  return all
    .filter((record) => record[field] === value)
    .map((record) => String(record.id))
    .sort()
}
