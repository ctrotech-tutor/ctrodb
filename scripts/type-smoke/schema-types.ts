/**
 * Schema-derived types, compiled against the *built* declarations.
 *
 * This is the guard for the whole M-14 surface: if the emitted `.d.ts` loses
 * the `const` inference, widens a field, or drops a relation, this file stops
 * compiling. Every `@ts-expect-error` below documents a mistake that must be
 * rejected — if one becomes legal, the directive itself becomes an error.
 */
import { createDatabase, Database, defineSchema, inspectSyncQueue } from "ctrodb"
import { DatabaseProvider } from "ctrodb/react"

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
        tags: { type: "array", items: { type: "string" } },
      },
      relations: {
        author: { type: "belongs_to", collection: "authors", foreignKey: "authorId" },
      },
    },
  },
})

const db = createDatabase({ name: "types", schema, adapter: "memory" })
const posts = db.collection("posts")

// A typed database is still an ordinary Database: helpers and providers accept it.
const asPlainDatabase: Database = db
void asPlainDatabase
void inspectSyncQueue(db)
export function Provider({ children }: { children: React.ReactNode }) {
  return DatabaseProvider({ db, children })
}

export async function createInputs() {
  // `title` is required; `views` has a default and `draft` has neither, so both
  // are optional inputs.
  await posts.create({ title: "hello" })
  await posts.create({ title: "hello", views: 3, draft: true, authorId: "a1" })

  // @ts-expect-error `title` is required
  await posts.create({ authorId: "a1" })
  // @ts-expect-error `views` is a number
  await posts.create({ title: "x", views: "three" })
  // @ts-expect-error unknown field
  await posts.create({ title: "x", nope: 1 })
}

export async function readsAndRelations() {
  const post = await posts.get("p1")
  if (!post) return

  const title: string = post.title
  const views: number | undefined = post.views
  const tags: string[] | undefined = post.tags
  void title
  void views
  void tags

  // @ts-expect-error the schema does not declare this field
  post.nope

  // belongs_to resolves to one record…
  const author = await post.load("author")
  const name: string | undefined = author?.name
  void name

  // …has_many resolves to an array.
  const authors = db.collection("authors")
  const first = await authors.get("a1")
  const written = await first?.load("posts")
  const firstTitle: string | undefined = written?.[0]?.title
  void firstTitle

  // @ts-expect-error not a relation of posts
  await post.load("posts")
  // @ts-expect-error not a relation at all
  await post.load("nope")
}

export function queries() {
  posts.query().where("views", ">", 10)
  posts.query().where("title", "hello")
  posts.query().where("id", "p1")
  posts.query().sort({ views: "desc" }).limit(10)
  posts.query().search("title", "hello")

  // @ts-expect-error the value must match the field type
  posts.query().where("views", ">", "ten")
  // @ts-expect-error the field must exist
  posts.query().where("nope", 1)
  // @ts-expect-error unknown operator
  posts.query().where("views", "=~", 1)
  // @ts-expect-error the sort key must be a field
  posts.query().sort({ nope: "asc" })
  // @ts-expect-error search needs a string field
  posts.query().search("views", "hello")
}

// Without a schema, `collection()` keeps its untyped contract.
export function untypedStillWorks() {
  const plain = new Database({ adapter: "memory" })
  return plain.collection("anything").create({ a: 1 })
}
