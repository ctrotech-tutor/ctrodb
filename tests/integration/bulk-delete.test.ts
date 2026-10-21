/**
 * `deleteMany()` used to read the records it was about to delete one at a time:
 *
 *     for (const id of ids) await adapter.findById(collection, id)
 *
 * The reads exist so each emitted `delete` event can carry `oldRecord`, but on
 * IndexedDB every `findById` opens its own transaction, so deleting 1,000 ids
 * opened 1,000 transactions before the single delete transaction that did the
 * work. The adapter now offers an optional `findByIds` (one transaction, N
 * gets) and `deleteMany` uses it, falling back to the loop for third-party
 * adapters that do not implement it.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryAdapter } from "../../src/adapter/memory"
import { Database } from "../../src/database"
import type { ChangeEvent, StorageAdapter } from "../../src/types"

const schema = {
  version: 1,
  collections: {
    items: { fields: { name: { type: "string" } } },
  },
}

const open: Database[] = []

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
})

async function makeDb(adapter: "memory" | "indexeddb" | StorageAdapter): Promise<Database> {
  const db = new Database({
    name: `bulk-${Math.random().toString(36).slice(2)}`,
    adapter,
    schema: schema as never,
  })
  await db.connect()
  open.push(db)
  return db
}

describe.each(["memory", "indexeddb"] as const)("deleteMany (%s)", (adapterName) => {
  it("reads the records once instead of per id", async () => {
    const db = await makeDb(adapterName)
    const items = db.collection("items")
    const ids: string[] = []
    for (let i = 0; i < 25; i++) {
      const item = await items.create({ name: `item ${i}` })
      ids.push(item.id as string)
    }

    const adapter = db._getAdapter()
    const findById = vi.spyOn(adapter, "findById")
    const findByIds = vi.spyOn(adapter, "findByIds")

    await items.deleteMany(ids)

    expect(findByIds).toHaveBeenCalledTimes(1)
    expect(findByIds.mock.calls[0]?.[1]).toHaveLength(ids.length)
    expect(findById).not.toHaveBeenCalled()
    expect(await items.count()).toBe(0)
  })

  it("still reports the previous record in every delete event", async () => {
    const db = await makeDb(adapterName)
    const items = db.collection("items")
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push((await items.create({ name: `named ${i}` })).id as string)
    }

    const events: ChangeEvent[] = []
    db.on((event) => {
      if (event.type === "delete") events.push(event)
    })

    await items.deleteMany(ids)

    expect(events).toHaveLength(3)
    expect(events.map((event) => (event.oldRecord as { name: string }).name).sort()).toEqual([
      "named 0",
      "named 1",
      "named 2",
    ])
  })
})

describe("deleteMany without the bulk-read capability", () => {
  it("falls back to one findById per id", async () => {
    const adapter = new MemoryAdapter()
    // Simulate a third-party adapter written against the previous interface.
    Object.defineProperty(adapter, "findByIds", { value: undefined })

    const db = await makeDb(adapter as StorageAdapter)
    const items = db.collection("items")
    const first = await items.create({ name: "a" })
    const second = await items.create({ name: "b" })

    await items.deleteMany([first.id as string, second.id as string])

    expect(await items.count()).toBe(0)
  })

  it("treats ids that do not exist as already gone", async () => {
    const db = await makeDb("memory")
    const items = db.collection("items")
    const item = await items.create({ name: "here" })

    const events: ChangeEvent[] = []
    db.on((event) => {
      if (event.type === "delete") events.push(event)
    })

    await items.deleteMany([item.id as string, "missing-id"])

    expect(await items.count()).toBe(0)
    expect(events).toHaveLength(2)
    expect(events.find((event) => event.recordId === "missing-id")?.oldRecord).toBeUndefined()
  })
})
