/**
 * Consumer-side type smoke test.
 *
 * Compiles against the *built* declarations (not `src/`), which is what
 * consumers actually get. This is the check that would have caught the
 * duplicated `Database` declaration: `DatabaseProvider` must accept a Database
 * instantiated by the consumer.
 *
 * Run by `npm run build:verify` and by CI after `npm run build`.
 */
import { Database } from "ctrodb"
import { DatabaseProvider, useDatabase } from "ctrodb/react"
import type { QueryResult } from "ctrodb/react"

const db: Database = new Database({
  name: "type-smoke",
  adapter: "memory",
  schema: { version: 1, collections: { todos: { fields: { text: { type: "string" } } } } },
})

// Same nominal type: a Database from "ctrodb" is accepted by "ctrodb/react".
export function Provider({ children }: { children: React.ReactNode }) {
  return DatabaseProvider({ db, children })
}

export function useSameDb(): Database {
  return useDatabase()
}

export type { QueryResult }

const results: QueryResult<{ text: string }> = {
  data: [],
  loading: false,
  error: undefined,
}
void results
