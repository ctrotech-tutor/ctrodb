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

/** @deprecated Use <DatabaseProvider> instead. Will be removed in v2.0. */
export function setDefaultDatabase(db: Database): void {
  console.warn(
    "[ctrodb] setDefaultDatabase() is deprecated. Wrap your app in <DatabaseProvider db={db}> instead.",
  )
  defaultDb = db
}

/** @deprecated Use <DatabaseProvider> and useDatabase() instead. Will be removed in v2.0. */
export function getDb(): Database {
  if (!defaultDb) {
    throw new Error(
      "No database instance found. Wrap your app in <DatabaseProvider db={db}> or call setDefaultDatabase(db).",
    )
  }
  return defaultDb
}

const DbContext = createContext<Database | null>(null)

export function DatabaseProvider({ db, children }: { db: Database; children: React.ReactNode }) {
  return createElement(DbContext.Provider, { value: db }, children)
}

export function useDatabase(): Database {
  const ctx = useContext(DbContext)
  if (ctx) return ctx
  return getDb()
}

export interface QueryResult<T extends Record<string, unknown>> {
  data: Array<Model<T> & T>
  loading: boolean
  error: Error | undefined
}

export interface DocResult<T extends Record<string, unknown>> {
  data: (Model<T> & T) | undefined
  loading: boolean
  error: Error | undefined
}

export function useQuery<T extends Record<string, unknown>>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  deps: unknown[] = [],
): QueryResult<T> {
  const db = useDatabase()
  const [results, setResults] = useState<Array<Model<T> & T>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | undefined>()
  const queryFnRef = useRef(queryFn)
  queryFnRef.current = queryFn

  useEffect(() => {
    const collection = db.collection<T>(collectionName)
    let cancelled = false

    async function runQuery() {
      setLoading(true)
      setError(undefined)
      let query = collection.query()
      if (queryFnRef.current) {
        query = queryFnRef.current(query)
      }
      try {
        const data = await query.fetch()
        if (!cancelled) setResults(data)
      } catch (e) {
        if (!cancelled) setError(e as Error)
      } finally {
        if (!cancelled) setLoading(false)
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

  return { data: results, loading, error }
}

export function useDoc<T extends Record<string, unknown>>(
  collectionName: string,
  id: ID | undefined,
): DocResult<T> {
  const { data, loading, error } = useQuery<T>(
    collectionName,
    (q) => q.where("id" as any, "==" as any, id as any),
    [id],
  )
  return { data: data[0], loading, error }
}

export function useMutation<T extends Record<string, unknown>>(
  collectionName: string,
): {
  create: (data: Omit<T, "id"> & { id?: ID }) => Promise<Model<T> & T>
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
    async (data: Omit<T, "id"> & { id?: ID }) => {
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
