/**
 * Planner correctness for index eligibility.
 *
 * Regression coverage for audit findings H-07 (`!=` on an indexed field
 * returned wrong rows) and the indexed-boolean `DataError`.
 *
 * The invariant: *the presence of an index must never change a result set.*
 * Every case is executed both with and without indexes and compared.
 */
import { describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import type { CollectionSchema, SchemaConfig } from "../../src/types"

const fields: CollectionSchema["fields"] = {
  name: { type: "string" },
  age: { type: "number" },
  tag: { type: "string" },
  done: { type: "boolean" },
  joined: { type: "object" },
}

const rows = [
  { id: "a", name: "Ada", age: 36, tag: "x", done: true, joined: { at: 1 } },
  { id: "b", name: "Bob", age: 20, tag: "x", done: false, joined: { at: 2 } },
  { id: "c", name: "Cy", age: 51, tag: "y", done: true, joined: { at: 3 } },
  { id: "d", name: "Di", age: 20, tag: "z", done: false, joined: { at: 4 } },
]

async function seed(adapter: "memory" | "indexeddb", indexes: { field: string }[]) {
  const schema: SchemaConfig = {
    version: 1,
    collections: { users: { fields, indexes } },
  }
  const db = new Database({
    name: `planner-${adapter}-${Math.random().toString(36).slice(2)}`,
    adapter,
    schema,
  })
  await db.connect()
  const users = db.collection("users")
  for (const row of rows) await users.create(row)
  return { db, users }
}

const queries: Array<
  [string, (q: ReturnType<Awaited<ReturnType<typeof seed>>["users"]["query"]>) => unknown]
> = [
  ["not equal on indexed field", (q) => q.where("tag", "!=", "x")],
  ["boolean equality on indexed field", (q) => q.where("done", "==", true)],
  ["object equality on indexed field", (q) => q.where("joined", "==", { at: 1 })],
  ["equality", (q) => q.where("tag", "==", "x")],
  ["range", (q) => q.where("age", ">", 20)],
  ["range inclusive", (q) => q.where("age", ">=", 20)],
  ["combined indexed + non-indexed", (q) => q.where("age", ">=", 20).where("name", "!=", "Di")],
]

describe.each(["memory", "indexeddb"] as const)("planner index eligibility (%s)", (adapter) => {
  it.each(queries)("%s returns the same rows with and without an index", async (_label, build) => {
    const unindexed = await seed(adapter, [])
    const indexed = await seed(adapter, [
      { field: "tag" },
      { field: "age" },
      { field: "done" },
      { field: "joined" },
    ])

    const plainRows = (
      await (build(unindexed.users.query()) as { fetch(): Promise<unknown[]> }).fetch()
    ).map((r) => (r as { id: string }).id)
    const indexedRows = (
      await (build(indexed.users.query()) as { fetch(): Promise<unknown[]> }).fetch()
    ).map((r) => (r as { id: string }).id)

    expect(indexedRows.sort()).toEqual(plainRows.sort())

    await unindexed.db.disconnect()
    await indexed.db.disconnect()
  })
})

describe("planner index eligibility — expected values", () => {
  it("filters != correctly when the field is indexed", async () => {
    const { db, users } = await seed("memory", [{ field: "tag" }])
    const result = await users.query().where("tag", "!=", "x").fetch()
    expect(result.map((r) => r.id).sort()).toEqual(["c", "d"])
    await db.disconnect()
  })

  it("does not fail on a boolean index", async () => {
    const { db, users } = await seed("memory", [{ field: "done" }])
    const result = await users.query().where("done", "==", true).fetch()
    expect(result.map((r) => r.id).sort()).toEqual(["a", "c"])
    await db.disconnect()
  })

  it("still uses the index when it is usable", async () => {
    const { db, users } = await seed("memory", [{ field: "age" }])
    const result = await users.query().where("age", "==", 20).fetch()
    expect(result.map((r) => r.id).sort()).toEqual(["b", "d"])
    await db.disconnect()
  })

  it("falls back to a scan for an id equality with a non-key value", async () => {
    const { db, users } = await seed("memory", [])
    const result = await users.query().where("id", "==", undefined).fetch()
    expect(result).toHaveLength(0)
    await db.disconnect()
  })
})
