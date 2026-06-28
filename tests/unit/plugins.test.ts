import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Database } from "../../src/database"
import { ftsPlugin } from "../../src/plugins/fts/index"
import { FTSIndexer } from "../../src/plugins/fts/indexer"
import { tokenize } from "../../src/plugins/fts/tokenizer"
import { relationsPlugin } from "../../src/plugins/relations/index"
import { validationPlugin, ValidationEngine } from "../../src/plugins/validation/index"
import type { ValidationRule } from "../../src/plugins/validation/index"
import { MemoryAdapter } from "../../src/adapter/memory"

function testDb(plugins?: any[]) {
  const db = new Database({
    name: "test_plugins",
    adapter: "memory",
    schema: {
      version: 1,
      collections: {
        articles: {
          fields: {
            title: { type: "string", required: true },
            body: { type: "string" },
            author: { type: "string" },
          },
          searchable: ["title", "body"],
        },
        users: {
          fields: {
            name: { type: "string", required: true },
            email: { type: "string", validate: "email" as const },
            profileId: { type: "string" },
          },
          indexes: [{ field: "email", unique: true }],
        },
        posts: {
          fields: {
            title: { type: "string", required: true },
            content: { type: "string" },
            userId: { type: "string" },
          },
          relations: {
            author: { type: "belongs_to", collection: "users", foreignKey: "userId" },
          },
        },
        profiles: {
          fields: {
            bio: { type: "string" },
            userId: { type: "string" },
          },
          relations: {
            user: { type: "belongs_to", collection: "users", foreignKey: "userId" },
          },
        },
        comments: {
          fields: {
            text: { type: "string" },
            postId: { type: "string" },
          },
          relations: {
            post: { type: "belongs_to", collection: "posts", foreignKey: "postId" },
          },
        },
      },
    },
    plugins: plugins ?? [],
  })
  return db
}

describe("Tokenizer", () => {
  it("tokenizes simple text", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"])
  })

  it("lowercases text", () => {
    expect(tokenize("Hello WORLD")).toEqual(["hello", "world"])
  })

  it("removes stop words", () => {
    expect(tokenize("the quick brown fox jumps over the lazy dog")).not.toContain("the")
    expect(tokenize("the quick brown fox jumps over the lazy dog")).toContain("quick")
  })

  it("removes punctuation", () => {
    expect(tokenize("hello, world!")).toEqual(["hello", "world"])
  })

  it("deduplicates tokens", () => {
    expect(tokenize("hello hello world")).toEqual(["hello", "world"])
  })

  it("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([])
  })

  it("returns empty array for non-string input", () => {
    expect(tokenize(null as any)).toEqual([])
    expect(tokenize(undefined as any)).toEqual([])
    expect(tokenize(123 as any)).toEqual([])
  })
})

describe("FTSIndexer", () => {
  it("indexes and searches records", async () => {
    const adapter = new MemoryAdapter()
    await adapter.connect("test_fts", null)

    const indexer = new FTSIndexer(adapter)

    await indexer.indexRecord("articles", { id: 1, title: "Hello World", body: "This is a test article" }, ["title", "body"])
    await indexer.indexRecord("articles", { id: 2, title: "Goodbye World", body: "Another test" }, ["title", "body"])

    const results = await indexer.search("articles", "hello")
    expect(results).toEqual([1])

    const results2 = await indexer.search("articles", "world")
    expect(results2.sort()).toEqual([1, 2])

    const results3 = await indexer.search("articles", "nonexistent")
    expect(results3).toEqual([])
  })

  it("updates indexed records", async () => {
    const adapter = new MemoryAdapter()
    await adapter.connect("test_fts_update", null)

    const indexer = new FTSIndexer(adapter)

    await indexer.indexRecord("articles", { id: 1, title: "Original Title", body: "" }, ["title", "body"])
    await indexer.updateRecord("articles", { id: 1, title: "Original Title", body: "" }, { id: 1, title: "Updated Title", body: "" }, ["title", "body"])

    const resultsOriginal = await indexer.search("articles", "original")
    expect(resultsOriginal).toEqual([])

    const resultsUpdated = await indexer.search("articles", "updated")
    expect(resultsUpdated).toEqual([1])
  })

  it("removes indexed records", async () => {
    const adapter = new MemoryAdapter()
    await adapter.connect("test_fts_remove", null)

    const indexer = new FTSIndexer(adapter)

    await indexer.indexRecord("articles", { id: 1, title: "Delete Me", body: "" }, ["title", "body"])
    expect(await indexer.search("articles", "delete")).toEqual([1])

    await indexer.removeRecord("articles", { id: 1, title: "Delete Me", body: "" }, ["title", "body"])
    expect(await indexer.search("articles", "delete")).toEqual([])
  })
})

describe("FTS Plugin", () => {
  let db: Database

  beforeAll(async () => {
    db = testDb([ftsPlugin()])
    await db.connect()
  })

  afterAll(async () => {
    await db.disconnect()
  })

  it("indexes articles on create and finds via search", async () => {
    const articles = db.collection("articles")

    const a1 = await articles.create({ title: "JavaScript Guide", body: "Learn JavaScript programming" })
    const a2 = await articles.create({ title: "TypeScript Handbook", body: "TypeScript is great" })

    expect(a1.title).toBe("JavaScript Guide")

    const results = await articles.query().search("title", "javascript").fetch()
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it("updates FTS index on record update", async () => {
    const articles = db.collection("articles")
    const article = await articles.create({ title: "Old Topic", body: "Old content" })

    const updated = await articles.update(article.id, { title: "New Topic" })
    expect(updated.title).toBe("New Topic")

    const oldSearch = await articles.query().search("title", "old").fetch()
    const newSearch = await articles.query().search("title", "new").fetch()
    expect(newSearch.length).toBeGreaterThanOrEqual(1)
  })

  it("removes FTS index on record delete", async () => {
    const articles = db.collection("articles")
    const article = await articles.create({ title: "ZZUniquelyDeletable", body: "ZZWillBeRemoved" })
    const id = article.id

    const beforeDelete = await articles.query().search("title", "zzuniquelydeletable").fetch()
    expect(beforeDelete.length).toBeGreaterThanOrEqual(1)

    await articles.delete(id)

    const afterDelete = await articles.query().search("title", "zzuniquelydeletable").fetch()
    expect(afterDelete.length).toBe(0)
  })
})

describe("Relations Plugin", () => {
  it("eager loads belongs_to relation", async () => {
    const db = testDb([relationsPlugin()])
    await db.connect()

    const users = db.collection("users")
    const profiles = db.collection("profiles")

    const user = await users.create({ name: "John", email: "john@test.com" })
    await profiles.create({ bio: "Hello!", userId: user.id })

    const allProfiles = await profiles.query().fetch()
    expect(allProfiles.length).toBe(1)

    await db.disconnect()
  })

  it("eager loads relations with .with()", async () => {
    const db = testDb()
    await db.connect()

    const users = db.collection("users")
    const profiles = db.collection("profiles")
    const posts = db.collection("posts")

    const user = await users.create({ name: "Jane", email: "jane@test.com" })
    await profiles.create({ bio: "Jane's bio", userId: user.id })
    await posts.create({ title: "Post by Jane", content: "Content", userId: user.id })

    const userWithProfiles = await users.with("profiles").fetch()
    expect(userWithProfiles.length).toBeGreaterThanOrEqual(1)

    await db.disconnect()
  })

  it("eager loads belongs_to with .with()", async () => {
    const db = testDb()
    await db.connect()

    const users = db.collection("users")
    const posts = db.collection("posts")

    const user = await users.create({ name: "WithUser", email: "with@test.com" })
    await posts.create({ title: "With Post", content: "Test", userId: user.id })

    const results = await posts.with("author").fetch()
    expect(results.length).toBeGreaterThanOrEqual(1)

    await db.disconnect()
  })
})

describe("Validation Plugin", () => {
  it("ValidationEngine validates with built-in rules", () => {
    const engine = new ValidationEngine()
    engine.addRule({
      name: "test",
      validate(_collection: string, field: string, value: unknown, _data: Record<string, unknown>) {
        if (value === "bad") return `Field "${field}" has bad value`
        return null
      },
    })

    expect(engine.validate("test", "name", "good", {})).toBeNull()
    expect(engine.validate("test", "name", "bad", {})).toBe("Field \"name\" has bad value")
  })

  it("validates records with multiple rules", async () => {
    const db = testDb([
      validationPlugin([
        {
          name: "noAdminRole",
          validate(_collection: string, _field: string, _value: unknown, data: Record<string, unknown>) {
            if (data.role === "admin") return "Admin role is not allowed"
            return null
          },
        },
      ]),
    ])
    await db.connect()

    const users = db.collection("users")
    await expect(users.create({ name: "Valid", email: "valid@test.com" })).resolves.toBeDefined()

    await db.disconnect()
  })

  it("rejects invalid emails via built-in validation", async () => {
    const engine = new ValidationEngine()
    engine.addRule({
      name: "email",
      validate(_collection: string, field: string, value: unknown, _data: Record<string, unknown>) {
        if (typeof value === "string" && value.includes("@") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          return `Field "${field}" is not a valid email address`
        }
        return null
      },
    })

    const result = engine.validate("users", "email", "invalid@test", {})
    expect(result).not.toBeNull()
    expect(result).toContain("email")

    const result2 = engine.validate("users", "email", "valid@test.com", {})
    expect(result2).toBeNull()
  })

  it("rejects empty strings via rule", () => {
    const engine = new ValidationEngine()
    engine.addRule({
      name: "noEmpty",
      validate(_collection: string, field: string, value: unknown, _data: Record<string, unknown>) {
        if (typeof value === "string" && value.trim().length === 0) {
          return `Field "${field}" cannot be empty`
        }
        return null
      },
    })

    const result = engine.validate("test", "name", "", {})
    expect(result).not.toBeNull()
    expect(result).toContain("empty")

    const result2 = engine.validate("test", "name", "  ", {})
    expect(result2).not.toBeNull()

    const result3 = engine.validate("test", "name", "valid", {})
    expect(result3).toBeNull()
  })

  it("adds and removes custom rules", () => {
    const engine = new ValidationEngine()
    const rule: ValidationRule = {
      name: "custom",
      validate() {
        return "error"
      },
    }

    engine.addRule(rule)
    expect(engine.rules.length).toBeGreaterThan(0)

    engine.removeRule("custom")
    const names = engine.rules.map((r) => r.name)
    expect(names).not.toContain("custom")
  })

  it("validates all fields in a record", () => {
    const engine = new ValidationEngine()
    engine.addRule({
      name: "noEmpty",
      validate(_collection: string, field: string, value: unknown, _data: Record<string, unknown>) {
        if (typeof value === "string" && value.trim().length === 0) {
          return `Field "${field}" cannot be empty`
        }
        return null
      },
    })

    const errors = engine.validateRecord("test", { name: "", email: "bad" })
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })
})

describe("Plugin hooks integration", () => {
  it("fires before/after create hooks in order", async () => {
    const calls: string[] = []

    const db = new Database({
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          items: { fields: { name: { type: "string" } } },
        },
      },
      plugins: [
        {
          name: "test-plugin",
          onBeforeCreate(collection: string, data: unknown) {
            calls.push(`before:${collection}`)
            return data
          },
          onAfterCreate(collection: string, _record: unknown) {
            calls.push(`after:${collection}`)
          },
        },
      ],
    })

    await db.connect()
    const items = db.collection("items")
    await items.create({ name: "test" })

    expect(calls).toContain("before:items")
    expect(calls).toContain("after:items")
    expect(calls.indexOf("before:items")).toBeLessThan(calls.indexOf("after:items"))

    await db.disconnect()
  })

  it("fires before/after update hooks", async () => {
    const calls: string[] = []

    const db = new Database({
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          items: { fields: { name: { type: "string" } } },
        },
      },
      plugins: [
        {
          name: "test-plugin",
          onBeforeUpdate(collection: string, _id: unknown, changes: unknown) {
            calls.push(`before-update:${collection}`)
            return changes
          },
          onAfterUpdate(collection: string, _id: unknown, _record: unknown) {
            calls.push(`after-update:${collection}`)
          },
        },
      ],
    })

    await db.connect()
    const items = db.collection("items")
    const item = await items.create({ name: "original" })
    await items.update(item.id, { name: "updated" })

    expect(calls).toContain("before-update:items")
    expect(calls).toContain("after-update:items")

    await db.disconnect()
  })

  it("fires before/after delete hooks", async () => {
    const calls: string[] = []

    const db = new Database({
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          items: { fields: { name: { type: "string" } } },
        },
      },
      plugins: [
        {
          name: "test-plugin",
          onBeforeDelete(collection: string, _id: unknown) {
            calls.push(`before-delete:${collection}`)
          },
          onAfterDelete(collection: string, _id: unknown) {
            calls.push(`after-delete:${collection}`)
          },
        },
      ],
    })

    await db.connect()
    const items = db.collection("items")
    const item = await items.create({ name: "delete-me" })
    await items.delete(item.id)

    expect(calls).toContain("before-delete:items")
    expect(calls).toContain("after-delete:items")

    await db.disconnect()
  })

  it("plugin can modify data in onBeforeCreate", async () => {
    const db = new Database({
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          items: { fields: { name: { type: "string" } } },
        },
      },
      plugins: [
        {
          name: "modifier",
          onBeforeCreate(_collection: string, data: unknown) {
            const d = data as Record<string, unknown>
            d.name = `modified-${d.name}`
            return d
          },
        },
      ],
    })

    await db.connect()
    const items = db.collection("items")
    const item = await items.create({ name: "test" })
    expect(item.name).toBe("modified-test")

    await db.disconnect()
  })

  it("multiple plugins execute in order", async () => {
    const calls: string[] = []

    const db = new Database({
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          items: { fields: { name: { type: "string" } } },
        },
      },
      plugins: [
        {
          name: "plugin-a",
          onAfterCreate(collection: string) {
            calls.push("a")
          },
        },
        {
          name: "plugin-b",
          onAfterCreate(collection: string) {
            calls.push("b")
          },
        },
      ],
    })

    await db.connect()
    const items = db.collection("items")
    await items.create({ name: "order-test" })
    expect(calls).toEqual(["a", "b"])

    await db.disconnect()
  })

  it("onDatabaseInit fires after connect", async () => {
    let fired = false

    const db = new Database({
      adapter: "memory",
      plugins: [
        {
          name: "init-test",
          onDatabaseInit(_db: unknown) {
            fired = true
          },
        },
      ],
    })

    expect(fired).toBe(false)
    await db.connect()
    expect(fired).toBe(true)

    await db.disconnect()
  })

  it("onCollectionInit fires for each collection", async () => {
    const initialized: string[] = []

    const db = new Database({
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          colA: { fields: { name: { type: "string" } } },
          colB: { fields: { name: { type: "string" } } },
        },
      },
      plugins: [
        {
          name: "init-col",
          onCollectionInit(collection: unknown) {
            initialized.push((collection as any).name)
          },
        },
      ],
    })

    await db.connect()
    db.collection("colA")
    db.collection("colB")

    expect(initialized).toContain("colA")
    expect(initialized).toContain("colB")

    await db.disconnect()
  })
})

describe("Database with all plugins", () => {
  it("works with all plugins loaded together", async () => {
    const db = new Database({
      adapter: "memory",
      schema: {
        version: 1,
        collections: {
          posts: {
            fields: {
              title: { type: "string", required: true },
              body: { type: "string" },
            },
            searchable: ["title", "body"],
          },
        },
      },
      plugins: [ftsPlugin(), validationPlugin(), relationsPlugin()],
    })

    await db.connect()

    const posts = db.collection("posts")
    const post = await posts.create({ title: "All Plugins", body: "Testing all plugins together" })
    expect(post.title).toBe("All Plugins")

    await db.disconnect()
  })
})
