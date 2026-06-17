/**
 * ctrodb — Node.js Example
 *
 * Run: node examples/node/index.mjs
 *
 * ctrodb works in Node.js using the Memory adapter.
 * For IndexedDB in Node, use fake-indexeddb or similar polyfills.
 */

import { Database } from "../../dist/index.js"

const schema = {
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string", required: true },
        email: { type: "string", validate: "email" },
        age: { type: "number", min: 0, max: 150 },
        role: { type: "string", default: "user" },
      },
      indexes: [{ field: "email", unique: true }],
    },
    posts: {
      fields: {
        title: { type: "string", required: true },
        content: { type: "string" },
        userId: { type: "number" },
      },
    },
  },
}

async function main() {
  const db = new Database({
    name: "myapp",
    adapter: "memory",
    schema,
  })

  await db.connect()
  console.log("✓ Connected to database:", db.name)

  // --- CRUD ---
  const users = db.collection("users")

  const alice = await users.create({ name: "Alice", email: "alice@test.com", age: 30 })
  console.log("\n✓ Created:", alice.name, "(id:", alice.id, ")")

  const bob = await users.create({ name: "Bob", email: "bob@test.com", age: 25 })

  // --- Query ---
  const adults = await users
    .query()
    .where("age", ">=", 18)
    .sort({ name: "asc" })
    .fetch()

  console.log("\n✓ Users aged 18+:", adults.map((u) => u.name).join(", "))

  // --- Update ---
  await alice.update({ age: 31 })
  console.log("✓ Updated Alice's age to 31")

  // --- Count ---
  const count = await users.count()
  console.log("✓ Total users:", count)

  // --- Delete ---
  await bob.delete()
  console.log("✓ Deleted Bob")

  const remaining = await users.getAll()
  console.log("✓ Remaining users:", remaining.length)

  // --- Plugin: FTS ---
  const { ftsPlugin } = await import("../../dist/index.js")
  const db2 = new Database({
    adapter: "memory",
    schema: {
      version: 1,
      collections: {
        articles: {
          fields: { title: { type: "string" }, body: { type: "string" } },
          searchable: ["title", "body"],
        },
      },
    },
    plugins: [ftsPlugin()],
  })
  await db2.connect()

  const articles = db2.collection("articles")
  await articles.create({ title: "Hello World", body: "My first article" })
  await articles.create({ title: "TypeScript Tips", body: "Learn TypeScript" })

  const results = await articles.query().search("title", "typescript").fetch()
  console.log("\n✓ FTS search results:", results.length)

  await db2.disconnect()

  // --- Cleanup ---
  await db.disconnect()
  console.log("\n✓ Done!")
}

main().catch(console.error)
