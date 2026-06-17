import { describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import { Schema } from "../../src/schema"
import { MemoryAdapter } from "../../src/adapter/memory"
import { ftsPlugin } from "../../src/plugins/fts/index"

describe("FTS search integration", () => {
  it("indexes new documents and finds them by search", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        docs: {
          fields: {
            title: { type: "string", required: true },
            body: { type: "string" },
          },
          searchable: ["title", "body"],
        },
      },
    })

    const db = new Database({
      name: "fts-search-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [ftsPlugin()],
    })
    await db.connect()

    const docs = db.collection("docs")
    await docs.create({ title: "The Quick Brown Fox", body: "Jumps over the lazy dog" })
    await docs.create({ title: "TypeScript Handbook", body: "A comprehensive guide" })
    await docs.create({ title: "React Patterns", body: "Common patterns in React" })

    const quick = await docs.query().search("title", "quick").fetch()
    expect(quick).toHaveLength(1)
    expect(quick[0].title).toBe("The Quick Brown Fox")

    const lazy = await docs.query().search("body", "lazy").fetch()
    expect(lazy).toHaveLength(1)
    expect(lazy[0].title).toBe("The Quick Brown Fox")

    const ts = await docs.query().search("title", "typescript").fetch()
    expect(ts).toHaveLength(1)

    const none = await docs.query().search("title", "python").fetch()
    expect(none).toHaveLength(0)

    await db.disconnect()
  })

  it("updates FTS index when document is updated", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        articles: {
          fields: {
            title: { type: "string", required: true },
          },
          searchable: ["title"],
        },
      },
    })

    const db = new Database({
      name: "fts-update-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [ftsPlugin()],
    })
    await db.connect()

    const articles = db.collection("articles")
    const doc = await articles.create({ title: "Old Title" })

    let found = await articles.query().search("title", "old").fetch()
    expect(found).toHaveLength(1)

    await articles.update(doc.id, { title: "New Title" })

    found = await articles.query().search("title", "old").fetch()
    expect(found).toHaveLength(0)

    found = await articles.query().search("title", "new").fetch()
    expect(found).toHaveLength(1)

    await db.disconnect()
  })

  it("removes document from FTS index when deleted", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        pages: {
          fields: {
            title: { type: "string", required: true },
          },
          searchable: ["title"],
        },
      },
    })

    const db = new Database({
      name: "fts-delete-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [ftsPlugin()],
    })
    await db.connect()

    const pages = db.collection("pages")
    const d1 = await pages.create({ title: "Keep Me" })
    const d2 = await pages.create({ title: "Delete Me" })

    expect(await pages.query().search("title", "keep").fetch()).toHaveLength(1)
    expect(await pages.query().search("title", "delete").fetch()).toHaveLength(1)

    await pages.delete(d2.id)

    expect(await pages.query().search("title", "delete").fetch()).toHaveLength(0)
    expect(await pages.query().search("title", "keep").fetch()).toHaveLength(1)

    await db.disconnect()
  })

  it("works with multiple searchable fields", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        entries: {
          fields: {
            title: { type: "string" },
            body: { type: "string" },
            tag: { type: "string" },
          },
          searchable: ["title", "body", "tag"],
        },
      },
    })

    const db = new Database({
      name: "fts-multi-field-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [ftsPlugin()],
    })
    await db.connect()

    const entries = db.collection("entries")
    await entries.create({ title: "Forest Walk", body: "Tall trees everywhere", tag: "nature" })
    await entries.create({ title: "City Trip", body: "Tall buildings everywhere", tag: "urban" })

    const titleMatch = await entries.query().search("title", "forest").fetch()
    expect(titleMatch).toHaveLength(1)

    const bodyMatch = await entries.query().search("body", "buildings").fetch()
    expect(bodyMatch).toHaveLength(1)

    const tagMatch = await entries.query().search("tag", "nature").fetch()
    expect(tagMatch).toHaveLength(1)

    await db.disconnect()
  })
})
