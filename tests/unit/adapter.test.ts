import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { MemoryAdapter } from "../../src/adapter/memory"
import { IndexedDBAdapter } from "../../src/adapter/idb"
import { createAdapter } from "../../src/adapter/create"
import { Schema } from "../../src/schema"

const testSchema = new Schema({
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string" },
        email: { type: "string" },
        age: { type: "number" },
      },
      indexes: [{ field: "email", unique: true }, { field: "age" }],
    },
    posts: {
      fields: {
        title: { type: "string" },
        content: { type: "string" },
      },
    },
  },
})

interface TestRecord {
  id: number | string
  name?: string
  email?: string
  age?: number
  title?: string
}

describe.each([
  { name: "MemoryAdapter", adapter: () => new MemoryAdapter() },
  { name: "IndexedDBAdapter", adapter: () => new IndexedDBAdapter() },
])("$name", ({ name: adapterName, adapter: createAdapterInstance }) => {
  let adapter: MemoryAdapter | IndexedDBAdapter
  let dbName: string

  beforeAll(async () => {
    adapter = createAdapterInstance() as any
    dbName = `test_${adapterName.toLowerCase()}_${Date.now()}`
    await adapter.connect(dbName, {
      version: 1,
      collections: {
        users: {
          fields: {
            name: { type: "string" },
            email: { type: "string" },
            age: { type: "number" },
          },
          indexes: [{ field: "email", unique: true }, { field: "age" }],
        },
        posts: {
          fields: {
            title: { type: "string" },
            content: { type: "string" },
          },
        },
      },
    })
  })

  afterAll(async () => {
    await adapter.disconnect()
  })

  it("is connected after connect", () => {
    expect(adapter.isConnected()).toBe(true)
  })

  it("creates a record with auto-increment id", async () => {
    const record = await adapter.create("users", {
      name: "Alice",
      email: "alice@test.com",
      age: 30,
    })
    expect(record.id).toBeDefined()
    expect(record.name).toBe("Alice")
  })

  it("finds a record by id", async () => {
    const record = await adapter.create("users", {
      name: "Bob",
      email: "bob@test.com",
      age: 25,
    })
    const found = await adapter.findById("users", record.id)
    expect(found).toBeDefined()
    expect(found!.name).toBe("Bob")
  })

  it("returns undefined for missing record", async () => {
    const found = await adapter.findById("users", 99999)
    expect(found).toBeUndefined()
  })

  it("returns all records", async () => {
    const all = await adapter.findAll("users")
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it("returns empty array for unknown collection", async () => {
    const all = await adapter.findAll("nonexistent")
    expect(all).toEqual([])
  })

  it("updates a record", async () => {
    const record = await adapter.create("users", {
      name: "Charlie",
      email: "charlie@test.com",
      age: 35,
    })
    const updated = await adapter.update("users", record.id, { age: 36 })
    expect(updated.age).toBe(36)
    expect(updated.name).toBe("Charlie")

    const found = await adapter.findById("users", record.id)
    expect(found!.age).toBe(36)
  })

  it("deletes a record", async () => {
    const record = await adapter.create("users", {
      name: "DeleteMe",
      email: "delete@test.com",
      age: 99,
    })
    await adapter.delete("users", record.id)
    const found = await adapter.findById("users", record.id)
    expect(found).toBeUndefined()
  })

  it("deletes multiple records", async () => {
    const r1 = await adapter.create("users", {
      name: "Batch1",
      email: "batch1@test.com",
      age: 10,
    })
    const r2 = await adapter.create("users", {
      name: "Batch2",
      email: "batch2@test.com",
      age: 10,
    })
    await adapter.deleteMany("users", [r1.id, r2.id])
    expect(await adapter.findById("users", r1.id)).toBeUndefined()
    expect(await adapter.findById("users", r2.id)).toBeUndefined()
  })

  it("scans index with equality range", async () => {
    const results = await adapter.scanIndex("users", "email", IDBKeyRange.only("alice@test.com"), [])
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("Alice")
  })

  it("scans index with lower bound range", async () => {
    const results = await adapter.scanIndex(
      "users",
      "age",
      IDBKeyRange.lowerBound(30),
      [],
    )
    for (const r of results) {
      expect((r.age as number) >= 30).toBe(true)
    }
  })

  it("scans index with post-filter conditions", async () => {
    const results = await adapter.scanIndex("users", "age", IDBKeyRange.lowerBound(30), [
      { type: "where", field: "name", op: "==", value: "Alice" },
    ])
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("Alice")
  })

  it("handles schema version", async () => {
    expect(await adapter.getSchemaVersion()).toBe(0)
    await adapter.setSchemaVersion(1)
    expect(await adapter.getSchemaVersion()).toBe(1)
  })

  it("handles metadata", async () => {
    await adapter.setMetadata("theme", "dark")
    expect(await adapter.getMetadata("theme")).toBe("dark")
    expect(await adapter.getMetadata("nonexistent")).toBeUndefined()
  })

  it("supports transaction rollback on error", async () => {
    const countBefore = (await adapter.findAll("users")).length

    try {
      await adapter.transaction(async (ctx) => {
        const col = ctx.collection("users") as {
          create(data: Record<string, unknown>): Promise<Record<string, unknown>>
        }
        await col.create({ name: "Rollback", email: "rollback@test.com", age: 0 })
        throw new Error("force rollback")
      })
    } catch {
      // expected
    }

    const countAfter = (await adapter.findAll("users")).length
    expect(countAfter).toBe(countBefore)
  })
})

describe("createAdapter", () => {
  it("creates MemoryAdapter when specified", () => {
    const adapter = createAdapter("memory")
    expect(adapter.name).toBe("memory")
  })

  it("creates IndexedDBAdapter when specified", () => {
    const adapter = createAdapter("indexeddb")
    expect(adapter.name).toBe("indexeddb")
  })

  it("auto-detects environment (falls back to memory in Node)", () => {
    const adapter = createAdapter()
    expect(adapter.name).toBe("memory")
  })
})
