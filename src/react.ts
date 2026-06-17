import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import type { Database } from "./database"
import type { Model } from "./model/index"
import type { QueryBuilder } from "./query/builder"
import type { ChangeEvent, ID } from "./types"

let defaultDb: Database | null = null

export function setDefaultDatabase(db: Database): void {
  defaultDb = db
}

export function getDb(): Database {
  if (!defaultDb) {
    throw new Error(
      "No database instance found. Call setDefaultDatabase(db) or wrap your app in <DatabaseProvider db={db}>.",
    )
  }
  return defaultDb
}

const DbContext = createContext<Database | null>(null)

export function DatabaseProvider({ db, children }: { db: Database; children: React.ReactNode }) {
  setDefaultDatabase(db)
  return createElement(DbContext.Provider, { value: db }, children)
}

export function useDatabase(): Database {
  const ctx = useContext(DbContext)
  if (!ctx) {
    return getDb()
  }
  return ctx
}

export function useQuery<T extends Record<string, unknown>>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  deps: unknown[] = [],
): Array<Model<T> & T> {
  const db = useDatabase()
  const [results, setResults] = useState<Array<Model<T> & T>>([])
  const queryFnRef = useRef(queryFn)
  queryFnRef.current = queryFn

  useEffect(() => {
    const collection = db.collection<T>(collectionName)
    let cancelled = false

    async function runQuery() {
      let query = collection.query()
      if (queryFnRef.current) {
        query = queryFnRef.current(query)
      }
      try {
        const data = await query.fetch()
        if (!cancelled) setResults(data)
      } catch {
        // query error handled silently — retry on next change
      }
    }

    runQuery()

    const unsub = db.on((_event: ChangeEvent) => {
      if (_event.collection === collectionName) {
        runQuery()
      }
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [collectionName, db, ...deps])

  return results
}

export function useDoc<T extends Record<string, unknown>>(
  collectionName: string,
  id: ID | undefined,
): (Model<T> & T) | undefined {
  const results = useQuery<T>(collectionName, (q) => q.where("id" as any, "==" as any, id as any), [
    id,
  ])
  return results[0]
}

export function useMutation<T extends Record<string, unknown>>(
  collectionName: string,
): {
  create: (data: Partial<T>) => Promise<Model<T> & T>
  update: (id: ID, changes: Partial<T>) => Promise<Model<T> & T>
  delete: (id: ID) => Promise<void>
  loading: boolean
  error: Error | undefined
  reset: () => void
} {
  const db = useDatabase()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | undefined>()

  const create = useCallback(
    async (data: Partial<T>) => {
      setLoading(true)
      setError(undefined)
      try {
        return await db.collection<T>(collectionName).create(data)
      } catch (e) {
        setError(e as Error)
        throw e
      } finally {
        setLoading(false)
      }
    },
    [collectionName, db],
  )

  const update = useCallback(
    async (id: ID, changes: Partial<T>) => {
      setLoading(true)
      setError(undefined)
      try {
        return await db.collection<T>(collectionName).update(id, changes)
      } catch (e) {
        setError(e as Error)
        throw e
      } finally {
        setLoading(false)
      }
    },
    [collectionName, db],
  )

  const del = useCallback(
    async (id: ID) => {
      setLoading(true)
      setError(undefined)
      try {
        await db.collection<T>(collectionName).delete(id)
      } catch (e) {
        setError(e as Error)
        throw e
      } finally {
        setLoading(false)
      }
    },
    [collectionName, db],
  )

  const reset = useCallback(() => {
    setError(undefined)
    setLoading(false)
  }, [])

  return { create, update, delete: del, loading, error, reset }
}
