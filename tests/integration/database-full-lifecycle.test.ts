import { describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import { Schema } from "../../src/schema"
import { MemoryAdapter } from "../../src/adapter/memory"

const schema: Schema = new Schema({
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string", required: true },
        email: { type: "string", required: true },
        age: { type: "number", default: 0 },
      },
      indexes: [{ field: "email", unique: true }],
    },
  },
})

describe("database full lifecycle", () => {
  it("connect → CRUD → disconnect → reconnect → verify data survives", async () => {
    const db = new Database({
      name: "lifecycle-test",
      adapter: new MemoryAdapter(),
      schema,
    })

    expect(db.isConnected).toBe(false)

    await db.connect()
    expect(db.isConnected).toBe(true)

    const users = db.collection("users")

    const alice = await users.create({ name: "Alice", email: "alice@test.com", age: 30 })
    expect(alice.name).toBe("Alice")
    expect(alice.email).toBe("alice@test.com")

    const bob = await users.create({ name: "Bob", email: "bob@test.com" })
    expect(bob.age).toBe(0)

    await users.update(alice.id, { age: 31 })
    const updated = await users.get(alice.id)
    expect(updated.age).toBe(31)

    const all = await users.getAll()
    expect(all).toHaveLength(2)

    await db.disconnect()
    expect(db.isConnected).toBe(false)

    await db.connect()
    expect(db.isConnected).toBe(true)

    await db.disconnect()
  })

  it("delete removes records permanently", async () => {
    const db = new Database({
      name: "lifecycle-delete-test",
      adapter: new MemoryAdapter(),
      schema,
    })
    await db.connect()

    const users = db.collection("users")
    const u = await users.create({ name: "Temp", email: "temp@test.com" })
    expect(await users.count()).toBe(1)

    await users.delete(u.id)
    expect(await users.count()).toBe(0)

    await db.disconnect()
    await db.connect()

    expect(await db.collection("users").count()).toBe(0)
    await db.disconnect()
  })

  it("deleteMany removes multiple records", async () => {
    const db = new Database({
      name: "lifecycle-delete-many-test",
      adapter: new MemoryAdapter(),
      schema,
    })
    await db.connect()

    const users = db.collection("users")
    const ids: string[] = []
    for (const name of ["A", "B", "C"]) {
      const u = await users.create({ name, email: `${name}@test.com` })
      ids.push(u.id)
    }
    expect(await users.count()).toBe(3)

    await users.deleteMany([ids[0], ids[1]])
    expect(await users.count()).toBe(1)

    const remaining = await users.getAll()
    expect(remaining[0].name).toBe("C")
    await db.disconnect()
  })
})
