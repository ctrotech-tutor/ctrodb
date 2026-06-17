import type { SchemaConfig } from "ctrodb"
import { Database } from "ctrodb"
import { ftsPlugin, relationsPlugin, validationPlugin } from "ctrodb"
import { DatabaseProvider } from "ctrodb/react"
import { useEffect, useState } from "react"
import { RelationsDemo } from "./RelationsDemo"
import { SearchDemo } from "./SearchDemo"
import { TodoApp } from "./TodoApp"

const schema: SchemaConfig = {
  collections: {
    todos: {
      fields: {
        text: { type: "string", required: true },
        done: { type: "boolean", default: false },
        createdAt: { type: "string", default: () => new Date().toISOString() },
      },
    },
    articles: {
      fields: {
        title: { type: "string", required: true },
        body: { type: "string", required: true },
        createdAt: { type: "string", default: () => new Date().toISOString() },
      },
      searchable: ["title", "body"],
    },
    authors: {
      fields: {
        name: { type: "string", required: true },
        email: { type: "string", required: true },
        createdAt: { type: "string", default: () => new Date().toISOString() },
      },
      indexes: [{ field: "email", unique: true }],
    },
    posts: {
      fields: {
        title: { type: "string", required: true },
        content: { type: "string", required: true },
        authorId: { type: "string", required: true },
        createdAt: { type: "string", default: () => new Date().toISOString() },
      },
    },
  },
  relations: [
    { type: "has_many", source: "authors", target: "posts", foreignKey: "authorId" },
    { type: "belongs_to", source: "posts", target: "authors", foreignKey: "authorId" },
  ],
}

const db = new Database({
  name: "ctrodb-demo",
  adapter: "memory",
  schema,
  plugins: [
    ftsPlugin(),
    relationsPlugin(),
    validationPlugin({
      rules: {
        email: [
          { name: "email", message: "Must be a valid email" },
        ],
      },
    }),
  ],
  logLevel: "error",
})

export function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<"todos" | "search" | "relations">("todos")

  useEffect(() => {
    db.connect().then(() => setReady(true)).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
    return () => { db.disconnect() }
  }, [])

  if (error) {
    return <div className="app"><div className="error">Connection failed: {error}</div></div>
  }

  if (!ready) {
    return <div className="app"><div className="loading">Connecting to database...</div></div>
  }

  return (
    <DatabaseProvider db={db}>
      <div className="app">
        <header className="header">
          <h1>ctrodb + React</h1>
          <p className="subtitle">Zero-dependency reactive client-side database</p>
          <nav className="tabs">
            {(["todos", "search", "relations"] as const).map((t) => (
              <button
                key={t}
                className={`tab ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "todos" ? "📋 Todos" : t === "search" ? "🔍 Search" : "🔗 Relations"}
              </button>
            ))}
          </nav>
        </header>
        <main className="main">
          {tab === "todos" && <TodoApp />}
          {tab === "search" && <SearchDemo />}
          {tab === "relations" && <RelationsDemo />}
        </main>
      </div>
    </DatabaseProvider>
  )
}
