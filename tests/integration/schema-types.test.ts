/**
 * M-14 — schema-derived types.
 *
 * The compile-time half of this lives in `scripts/type-smoke/schema-types.ts`
 * (checked against the built declarations by `npm run typecheck:smoke`). This
 * file covers the runtime contract the types describe, so a divergence between
 * "what the types promise" and "what the database does" fails here.
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { createDatabase, Database, defineSchema, SchemaError } from "../../src/index"

const schema = defineSchema({
  version: 1,
  collections: {
    authors: {
      fields: { name: { type: "string", required: true } },
      relations: {
        posts: { type: "has_many", collection: "posts", foreignKey: "authorId" },
      },
    },
    posts: {
      fields: {
        title: { type: "string", required: true },
        authorId: { type: "string" },
        views: { type: "number", default: 0 },
        draft: { type: "boolean" },
      },
      relations: {
        author: { type: "belongs_to", collection: "authors", foreignKey: "authorId" },
      },
    },
  },
})

describe("defineSchema", () => {
  it("validates the schema at definition time, not at connect()", () => {
    expect(() =>
      defineSchema({
        version: 1,
        collections: {
          things: {
            fields: { name: { type: "string" } },
            // `missing` is not a declared field.
            indexes: [{ field: "missing" }],
          },
        },
      }),
    ).toThrow(SchemaError)
  })

  it("returns the schema object unchanged", () => {
    const input = { version: 2, collections: { a: { fields: { b: { type: "string" } } } } }
    const defined = defineSchema(input)
    expect(defined).toBe(input)
    expect(defined.version).toBe(2)
  })
})

describe("createDatabase", () => {
  it("derives document types and still behaves like a Database", async () => {
    const db = createDatabase({ name: "schema-types", schema, adapter: "memory" })

    // A typed database must remain usable everywhere a Database is expected.
    const asPlain: Database = db
    expect(asPlain).toBe(db)

    await db.connect()

    const authors = db.collection("authors")
    const posts = db.collection("posts")

    const author = await authors.create({ name: "Ada" })
    const post = await posts.create({ title: "Notes", authorId: author.id })

    // `views` has a default, so it exists at runtime even though the type keeps
    // it optional (rows written before the default may not have it).
    expect(post.views).toBe(0)

    const loadedAuthor = await post.load("author")
    expect(loadedAuthor?.name).toBe("Ada")

    const written = await author.load("posts")
    expect(written.map((p) => p.title)).toEqual(["Notes"])

    // Types the runtime must honour: required field, defaulted-but-optional
    // field, and a typed relation result.
    expectTypeOf(post.title).toEqualTypeOf<string>()
    expectTypeOf(post.views).toEqualTypeOf<number | undefined>()
    expectTypeOf(author.name).toEqualTypeOf<string>()
    expectTypeOf(written[0]?.title).toEqualTypeOf<string | undefined>()
    expectTypeOf(loadedAuthor?.name).toEqualTypeOf<string | undefined>()

    await db.disconnect()
  })

  it("rejects an undeclared collection at runtime", async () => {
    const db = createDatabase({ name: "schema-types-typo", schema, adapter: "memory" })
    await db.connect()

    // The type layer allows the fallback overload for assignability reasons, so
    // the guarantee is enforced here.
    expect(() => (db.collection as (name: string) => unknown)("postz")).toThrow(
      /Collection "postz" not found/,
    )

    await db.disconnect()
  })

  it("keeps the untyped path for databases without a schema", async () => {
    const db = new Database({ name: "schema-types-plain", adapter: "memory" })
    await db.connect()

    const anything = await db.collection<{ label?: string }>("free-form").create({ label: "hello" })
    expect(anything.label).toBe("hello")

    await db.disconnect()
  })
})

describe("typed queries", () => {
  it("filters and sorts on declared fields", async () => {
    const db = createDatabase({ name: "schema-types-query", schema, adapter: "memory" })
    await db.connect()

    const posts = db.collection("posts")
    await posts.create({ id: "a", title: "one", views: 5 })
    await posts.create({ id: "b", title: "two", views: 50 })
    await posts.create({ id: "c", title: "three", views: 500 })

    const popular = await posts.query().where("views", ">", 10).sort({ views: "desc" }).fetch()
    expect(popular.map((p) => p.id)).toEqual(["c", "b"])

    const found = await posts.query().search("title", "TWO").fetch()
    expect(found.map((p) => p.title)).toEqual(["two"])

    await db.disconnect()
  })
})
