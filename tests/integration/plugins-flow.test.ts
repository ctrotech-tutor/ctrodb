import { describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import { Schema } from "../../src/schema"
import { MemoryAdapter } from "../../src/adapter/memory"
import { ftsPlugin } from "../../src/plugins/fts/index"
import { validationPlugin } from "../../src/plugins/validation/index"
import type { CtroDBPlugin, ChangeEvent } from "../../src/types"

describe("plugins integration", () => {
  it("FTS plugin indexes and searches documents through collection operations", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        notes: {
          fields: {
            title: { type: "string", required: true },
            body: { type: "string" },
          },
          searchable: ["title", "body"],
        },
      },
    })

    const db = new Database({
      name: "fts-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [ftsPlugin()],
    })
    await db.connect()

    const notes = db.collection("notes")
    await notes.create({ title: "Hello World", body: "This is a test note" })
    await notes.create({ title: "TypeScript Tips", body: "Use strict mode" })
    await notes.create({ title: "Groceries", body: "Buy milk and eggs" })

    const results1 = await notes.query().search("title", "hello").fetch()
    expect(results1).toHaveLength(1)
    expect(results1[0].title).toBe("Hello World")

    const results2 = await notes.query().search("title", "typescript").fetch()
    expect(results2).toHaveLength(1)
    expect(results2[0].title).toBe("TypeScript Tips")

    const updated = await notes.get(results1[0].id)
    await notes.update(updated.id, { title: "Greetings Earth" })
    const results3 = await notes.query().search("title", "hello").fetch()
    expect(results3).toHaveLength(0)

    const results4 = await notes.query().search("title", "greetings").fetch()
    expect(results4).toHaveLength(1)

    await notes.delete(updated.id)
    const results5 = await notes.query().search("title", "greetings").fetch()
    expect(results5).toHaveLength(0)

    await db.disconnect()
  })

  it("validation plugin rejects invalid data through collection operations", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        contacts: {
          fields: {
            name: { type: "string", required: true },
            email: { type: "string", required: true },
          },
        },
      },
    })

    const db = new Database({
      name: "validation-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [validationPlugin()],
    })
    await db.connect()

    const contacts = db.collection("contacts")

    await expect(
      contacts.create({ name: "Test", email: "bad@email" }),
    ).rejects.toThrow(/not a valid email|Field.*email/i)

    const valid = await contacts.create({ name: "Test", email: "test@example.com" })
    expect(valid.name).toBe("Test")

    await expect(
      contacts.update(valid.id, { email: "bad@email" }),
    ).rejects.toThrow(/not a valid email|Field.*email/i)

    await db.disconnect()
  })

  it("plugin hooks execute in order", async () => {
    const order: string[] = []

    const plugin1: CtroDBPlugin = {
      name: "plugin1",
      onBeforeCreate: async () => { order.push("1.beforeCreate") },
      onAfterCreate: async () => { order.push("1.afterCreate") },
    }

    const plugin2: CtroDBPlugin = {
      name: "plugin2",
      onBeforeCreate: async () => { order.push("2.beforeCreate") },
      onAfterCreate: async () => { order.push("2.afterCreate") },
    }

    const schema = new Schema({
      version: 1,
      collections: {
        items: {
          fields: {
            val: { type: "string" },
          },
        },
      },
    })

    const db = new Database({
      name: "plugin-order-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [plugin1, plugin2],
    })
    await db.connect()

    await db.collection("items").create({ val: "test" })

    expect(order).toEqual([
      "1.beforeCreate",
      "2.beforeCreate",
      "1.afterCreate",
      "2.afterCreate",
    ])

    await db.disconnect()
  })
})
