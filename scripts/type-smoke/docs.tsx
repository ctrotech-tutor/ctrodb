/**
 * Compiles the code examples that appear in README.md / docs, against the
 * *built* declarations.
 *
 * Documentation drifted from the shipped API before (audit M-19): the README
 * typed `useSync()` as `() => Promise<void>`, passed a `db` prop to a component
 * that reads it from context, and called `useSyncQueue(db)` with an argument the
 * hook does not take. Copy-pasting those snippets did not compile. This file is
 * that check, and it runs in `npm run build:verify` and in CI.
 *
 * Keep the snippets here in sync with the README when either changes.
 */

import type { DocumentOf } from "ctrodb"
import { createDatabase, type Database, defineSchema } from "ctrodb"
import {
  DatabaseProvider,
  SyncDevPanel,
  useDatabase,
  useDoc,
  useMutation,
  useQuery,
  useSync,
  useSyncQueue,
  useSyncStatus,
} from "ctrodb/react"

const schema = defineSchema({
  version: 1,
  collections: {
    authors: {
      fields: { name: { type: "string" } },
      relations: {
        posts: { type: "has_many", collection: "posts", foreignKey: "authorId" },
      },
    },
    posts: {
      fields: { title: { type: "string" }, authorId: { type: "string" } },
      searchable: ["title"],
      relations: {
        author: { type: "belongs_to", collection: "authors", foreignKey: "authorId" },
      },
    },
    todos: {
      fields: {
        text: { type: "string", required: true },
        status: { type: "string", default: "open" },
      },
    },
  },
})

// README quick start: typed database, still a `Database` everywhere.
const db = createDatabase({ name: "docs-smoke", adapter: "memory", schema })

// A plain interface, deliberately: the generic constraint used to be
// `Record<string, unknown>`, so interfaces without an index signature were
// rejected by `useQuery<Todo>`, `db.collection<Todo>()` and friends.
// Derived from the schema — no hand-written document interface (M-14).
type Todo = DocumentOf<typeof schema, "todos">

// README → Quick start / React
export function App() {
  return DatabaseProvider({ db, children: null })
}

export function TodoList() {
  const { data: todos, loading } = useQuery<Todo>("todos", (q) =>
    q.where("status", "==", "open").sort({ text: "asc" }),
  )
  const { create, delete: remove } = useMutation<Todo>("todos")

  if (loading) return null

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          {todo.text}
          <button type="button" onClick={() => void remove(todo.id)}>
            Delete
          </button>
          <span>{todo.status}</span>
        </li>
      ))}
      <button
        type="button"
        onClick={() =>
          void create({
            text: "New task",
            status: "open",
          })
        }
      >
        Add
      </button>
    </ul>
  )
}

// README → Batch inserts.
export async function batchExamples() {
  const todos = await db
    .collection("todos")
    .createMany([{ text: "a" }, { text: "b" }, { text: "c" }])
  return todos.map((todo) => todo.id)
}

// README → Search: substring vs tokenised.
export async function searchExamples() {
  const substring = await db.collection("posts").query().search("title", "quick").fetch()
  const tokenised = await db.collection("posts").query().match("typescript database").fetch()
  const scoped = await db.collection("posts").query().match("typescript", ["title"]).fetch()
  return { substring, tokenised, scoped }
}

// README → Hooks API: deps whose length changes between renders.
export function FilteredList({ status, page }: { status: string; page: number }) {
  const { data } = useQuery<Todo>("todos", (q) => q.where("status", "==", status).limit(20), [
    status,
    page,
  ])
  return <>{data.length}</>
}

export function SyncWidgets() {
  const { isConnected, pendingChanges } = useSyncStatus()
  const { sync } = useSync()
  const { snapshot, loading, error, refresh } = useSyncQueue()
  const current: Database = useDatabase()
  const { data: one } = useDoc<Todo>("todos", "t1")

  return (
    <div>
      <span>{isConnected ? "connected" : "offline"}</span>
      <span>{pendingChanges}</span>
      <span>{snapshot?.stats.pending ?? 0}</span>
      <span>{loading ? "…" : ""}</span>
      <span>{error?.message}</span>
      <span>{one?.text}</span>
      <span>{current.name}</span>
      <button type="button" onClick={() => void sync()}>
        Sync now
      </button>
      <button type="button" onClick={() => void refresh()}>
        Refresh queue
      </button>
      <SyncDevPanel />
      <SyncDevPanel maxEvents={10} />
    </div>
  )
}

// README → Models
export async function modelExamples() {
  const author = await db.collection("authors").get("a1")
  if (!author) return

  const keys: string[] = Object.keys(author)
  const plain = { ...author }
  const asJson: Record<string, unknown> = JSON.parse(JSON.stringify(author)) as Record<
    string,
    unknown
  >

  // README → Relations: lazy per model, eager per collection.
  const posts = await author.load("posts")
  const eager = await db.collection("authors").with("posts").fetch()

  void keys
  void plain
  void asJson
  void posts
  void eager
}

// README → React error handling: `error` is `Error | undefined`, not `null`.
export function ErrorMessage() {
  const { error } = useQuery<Todo>("todos")
  return <>{error instanceof Error ? error.message : null}</>
}
