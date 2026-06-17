import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Database } from "../../src/database"
import { ConnectionError } from "../../src/errors"

const testSchema = {
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string" as const, required: true },
        email: { type: "string" as const, validate: "email" as const },
        age: { type: "number" as const, min: 0, max: 150 },
        role: { type: "string" as const, default: "user" },
      },
      indexes: [{ field: "email", unique: true }, { field: "age" }],
    },
    posts: {
      fields: {
        title: { type: "string" as const, required: true },
        content: { type: "string" as const },
      },
    },
  },
}

describe("Database", () => {
  it("creates with default config", () => {
    const db = new Database()
    expect(db.name).toBe("ctrodb")
    expect(db.isConnected).toBe(false)
    expect(db.adapterName).toBe("memory")
  })

  it("creates with custom name", () => {
    const db = new Database({ name: "myapp" })
    expect(db.name).toBe("myapp")
  })

  it("creates with memory adapter", () => {
    const db = new Database({ adapter: "memory" })
    expect(db.adapterName).toBe("memory")
  })

  it("connects and disconnects", async () => {
    const db = new Database({ adapter: "memory" })
    expect(db.isConnected).toBe(false)
    await db.connect()
    expect(db.isConnected).toBe(true)
    await db.disconnect()
    expect(db.isConnected).toBe(false)
  })

  it("throws ConnectionError when collection accessed before connect", () => {
    const db = new Database({ adapter: "memory" })
    expect(() => db.collection("users")).toThrow(ConnectionError)
  })

  it("throws ConnectionError when transaction called before connect", async () => {
    const db = new Database({ adapter: "memory" })
    await expect(db.transaction(async () => {})).rejects.toThrow(ConnectionError)
  })
})

describe("Database with schema", () => {
  let db: Database

  beforeAll(async () => {
    db = new Database({
      name: "test_db",
      adapter: "memory",
      schema: testSchema,
    })
    await db.connect()
  })

  afterAll(async () => {
    await db.disconnect()
  })

  it("creates a record in a collection", async () => {
    const users = db.collection("users")
    const user = await users.create({ name: "Alice", email: "alice@test.com", age: 30 })
    expect(user.id).toBeDefined()
    expect(user.name).toBe("Alice")
  })

  it("retrieves a record by id", async () => {
    const users = db.collection("users")
    const created = await users.create({ name: "Bob", email: "bob@test.com", age: 25 })
    const found = await users.get(created.id)
    expect(found).toBeDefined()
    expect(found!.name).toBe("Bob")
  })

  it("returns undefined for missing record", async () => {
    const users = db.collection("users")
    const found = await users.get(99999)
    expect(found).toBeUndefined()
  })

  it("returns all records", async () => {
    const users = db.collection("users")
    const all = await users.getAll()
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  it("updates a record", async () => {
    const users = db.collection("users")
    const created = await users.create({ name: "Charlie", email: "charlie@test.com", age: 35 })
    const updated = await users.update(created.id, { age: 36 })
    expect(updated.age).toBe(36)
    expect(updated.name).toBe("Charlie")
  })

  it("deletes a record", async () => {
    const users = db.collection("users")
    const created = await users.create({ name: "DeleteMe", email: "delete@test.com", age: 99 })
    await users.delete(created.id)
    const found = await users.get(created.id)
    expect(found).toBeUndefined()
  })

  it("deletes multiple records", async () => {
    const users = db.collection("users")
    const a = await users.create({ name: "BatchA", email: "batcha@test.com", age: 10 })
    const b = await users.create({ name: "BatchB", email: "batchb@test.com", age: 10 })
    await users.deleteMany([a.id, b.id])
    expect(await users.get(a.id)).toBeUndefined()
    expect(await users.get(b.id)).toBeUndefined()
  })

  it("upserts with put (create new)", async () => {
    const users = db.collection("users")
    const created = await users.put({ name: "PutNew", email: "putnew@test.com", age: 20 })
    expect(created.id).toBeDefined()
    expect(created.name).toBe("PutNew")
  })

  it("upserts with put (update existing)", async () => {
    const users = db.collection("users")
    const created = await users.put({ name: "PutUpdate", email: "putupdate@test.com", age: 30 })
    const updated = await users.put({ id: created.id, name: "PutUpdated", age: 31 } as any)
    expect(updated.name).toBe("PutUpdated")
    expect(updated.age).toBe(31)
  })

  it("counts records", async () => {
    const posts = db.collection("posts")
    const countBefore = await posts.count()
    await posts.create({ title: "Post 1", content: "Content 1" })
    await posts.create({ title: "Post 2", content: "Content 2" })
    const countAfter = await posts.count()
    expect(countAfter).toBe(countBefore + 2)
  })

  it("validates required fields", async () => {
    const users = db.collection("users")
    await expect(users.create({} as any)).rejects.toThrow('is required')
  })

  it("validates field types", async () => {
    const users = db.collection("users")
    await expect(users.create({ name: "Test", age: "old" as any })).rejects.toThrow(
      'must be of type "number"',
    )
  })

  it("applies default values", async () => {
    const users = db.collection("users")
    const user = await users.create({ name: "DefaultTest", email: "default@test.com", age: 20 })
    expect((user as any).role).toBe("user")
  })

  it("supports query builder", async () => {
    const users = db.collection("users")
    await users.create({ name: "Query1", email: "q1@test.com", age: 30 })
    await users.create({ name: "Query2", email: "q2@test.com", age: 25 })
    const results = await users.query().where("age", ">=", 30).fetch()
    for (const r of results) {
      expect((r as any).age >= 30).toBe(true)
    }
  })

  it("supports query count", async () => {
    const users = db.collection("users")
    const count = await users.query().where("age", ">", 0).count()
    expect(count).toBeGreaterThan(0)
  })

  it("supports query first", async () => {
    const posts = db.collection("posts")
    await posts.create({ title: "FirstTest", content: "Testing first()" })
    const first = await posts.query().where("title", "FirstTest").first()
    expect(first).toBeDefined()
    expect(first!.title).toBe("FirstTest")
  })

  it("supports query toArray", async () => {
    const users = db.collection("users")
    const raw = await users.query().where("age", ">", 0).toArray()
    expect(raw.length).toBeGreaterThan(0)
    expect(raw[0]).not.toHaveProperty("update")
  })

  it("supports onChange listener", async () => {
    const users = db.collection("users")
    const events: any[] = []
    const unsub = users.onChange((event) => events.push(event))

    await users.create({ name: "ListenerTest", email: "listener@test.com", age: 1 })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("create")
    expect(events[0].collection).toBe("users")

    unsub()
    await users.create({ name: "NoListener", email: "nolistener@test.com", age: 2 })
    expect(events).toHaveLength(1)
  })

  it("supports db.on listener", async () => {
    const events: any[] = []
    const unsub = db.on((event) => events.push(event))

    const users = db.collection("users")
    await users.create({ name: "DBListener", email: "dblistener@test.com", age: 3 })

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[events.length - 1].type).toBe("create")

    unsub()
  })

  it("model has direct property access via proxy", async () => {
    const users = db.collection("users")
    const user = await users.create({ name: "ProxyTest", email: "proxy@test.com", age: 25 })
    expect(user.name).toBe("ProxyTest")
    expect(user.email).toBe("proxy@test.com")
    expect(user.age).toBe(25)
  })

  it("model.toJSON returns raw data", async () => {
    const users = db.collection("users")
    const user = await users.create({ name: "JSONTest", email: "json@test.com", age: 50 })
    const json = user.toJSON()
    expect(json.name).toBe("JSONTest")
    expect(json.email).toBe("json@test.com")
    expect(json.age).toBe(50)
  })

  it("model.update modifies record", async () => {
    const users = db.collection("users")
    const user = await users.create({ name: "ModelUpdate", email: "modelupdate@test.com", age: 40 })
    const updated = await user.update({ age: 41 })
    expect(updated.age).toBe(41)
    expect(updated.name).toBe("ModelUpdate")
  })

  it("model.delete removes record", async () => {
    const users = db.collection("users")
    const user = await users.create({ name: "ModelDelete", email: "modeldelete@test.com", age: 5 })
    const id = user.id
    await user.delete()
    const found = await users.get(id)
    expect(found).toBeUndefined()
  })

  it("supports pagination via query builder", async () => {
    const users = db.collection("users")
    const results = await users.query().sort({ age: "asc" }).limit(2).offset(1).toArray()
    expect(results.length).toBeLessThanOrEqual(2)
  })
})

describe("Static collections without schema", () => {
  let db: Database

  beforeAll(async () => {
    db = new Database({ name: "noschema", adapter: "memory" })
    await db.connect()
  })

  afterAll(async () => {
    await db.disconnect()
  })

  it("creates records without schema validation", async () => {
    const items = db.collection("items")
    const item = await items.create({ name: "Test", anything: "goes" })
    expect(item.id).toBeDefined()
    expect(item.name).toBe("Test")
    expect((item as any).anything).toBe("goes")
  })

  it("queries without schema", async () => {
    const items = db.collection("items")
    const results = await items.query().where("name", "Test").fetch()
    expect(results).toHaveLength(1)
  })
})
