import { describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import { Schema } from "../../src/schema"
import { MemoryAdapter } from "../../src/adapter/memory"
import { relationsPlugin } from "../../src/plugins/relations/index"

describe("relations plugin integration", () => {
  it("creates authors and posts, then eager loads with .with()", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        authors: {
          fields: {
            name: { type: "string", required: true },
          },
          relations: {
            posts: { type: "has_many", collection: "posts", foreignKey: "authorId" },
          },
        },
        posts: {
          fields: {
            title: { type: "string", required: true },
            authorId: { type: "number", required: true },
          },
          relations: {
            author: { type: "belongs_to", collection: "authors", foreignKey: "authorId" },
          },
        },
      },
    })

    const db = new Database({
      name: "relations-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [relationsPlugin()],
    })
    await db.connect()

    const alice = await db.collection("authors").create({ name: "Alice" })
    const bob = await db.collection("authors").create({ name: "Bob" })

    await db.collection("posts").create({ title: "Post 1", authorId: alice.id as number })
    await db.collection("posts").create({ title: "Post 2", authorId: alice.id as number })
    await db.collection("posts").create({ title: "Post 3", authorId: bob.id as number })

    const authorsWithPosts = await db.collection("authors").with("posts").fetch()

    expect(authorsWithPosts).toHaveLength(2)

    const aliceWithPosts = authorsWithPosts.find((a: any) => a.name === "Alice")
    const bobWithPosts = authorsWithPosts.find((a: any) => a.name === "Bob")

    expect(aliceWithPosts).toBeDefined()
    expect(aliceWithPosts.posts).toHaveLength(2)
    expect(aliceWithPosts.posts.map((p: any) => p.title).sort()).toEqual(["Post 1", "Post 2"])

    expect(bobWithPosts).toBeDefined()
    expect(bobWithPosts.posts).toHaveLength(1)
    expect(bobWithPosts.posts[0].title).toBe("Post 3")

    const postsWithAuthors = await db.collection("posts").with("author").fetch()
    expect(postsWithAuthors).toHaveLength(3)

    const post1 = postsWithAuthors.find((p: any) => p.title === "Post 1")
    expect(post1.author).toBeDefined()
    expect(post1.author.name).toBe("Alice")

    await db.disconnect()
  })

  it("handles empty relations gracefully", async () => {
    const schema = new Schema({
      version: 1,
      collections: {
        authors: {
          fields: {
            name: { type: "string", required: true },
          },
          relations: {
            posts: { type: "has_many", collection: "posts", foreignKey: "authorId" },
          },
        },
        posts: {
          fields: {
            title: { type: "string", required: true },
            authorId: { type: "number", required: true },
          },
          relations: {
            author: { type: "belongs_to", collection: "authors", foreignKey: "authorId" },
          },
        },
      },
    })

    const db = new Database({
      name: "relations-empty-test",
      adapter: new MemoryAdapter(),
      schema,
      plugins: [relationsPlugin()],
    })
    await db.connect()

    await db.collection("authors").create({ name: "Solo Author" })

    const authors = await db.collection("authors").with("posts").fetch()
    expect(authors).toHaveLength(1)
    expect(authors[0].posts).toEqual([])

    await db.disconnect()
  })
})
