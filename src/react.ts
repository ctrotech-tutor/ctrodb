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
import type {
  SyncEvent,
  SyncQueueSnapshot,
  SyncStatus,
} from "./sync/types"
import {
  createSyncEventLog,
  inspectSyncQueue,
  retryFailedSync,
} from "./sync/devtools"

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

// ── Sync Hooks ──

export interface SyncStatusResult {
  isSyncing: boolean
  isConnected: boolean
  lastSyncAt: string | null
  pendingChanges: number
  failedChanges: number
  lastError: string | null
}

export function useSyncStatus(): SyncStatusResult {
  const db = useDatabase()
  const [status, setStatus] = useState<SyncStatusResult>({
    isSyncing: false,
    isConnected: false,
    lastSyncAt: null,
    pendingChanges: 0,
    failedChanges: 0,
    lastError: null,
  })

  useEffect(() => {
    let cancelled = false

    async function update() {
      let s: SyncStatus
      try {
        s = db.syncStatus
      } catch {
        return
      }

      if (cancelled) return

      let pendingCount = 0
      let failedCount = 0
      try {
        pendingCount = await db.getPendingCount()
        failedCount = await db.getFailedCount()
      } catch {
        // counts unavailable — stay at 0
      }

      if (!cancelled) {
        setStatus({
          isSyncing: s.isSyncing,
          isConnected: s.isConnected,
          lastSyncAt: s.lastSyncAt,
          pendingChanges: pendingCount,
          failedChanges: failedCount,
          lastError: s.lastError,
        })
      }
    }

    update()

    let unsub: (() => void) | undefined
    try {
      unsub = db.onSync(() => {
        update()
      })
    } catch {
      // Sync plugin not registered — no events
    }

    const interval = setInterval(update, 5000)

    return () => {
      cancelled = true
      unsub?.()
      clearInterval(interval)
    }
  }, [db])

  return status
}

export function useSync(callback?: (event: SyncEvent) => void): {
  sync: () => Promise<void>
  status: SyncStatusResult
} {
  const db = useDatabase()
  const status = useSyncStatus()

  const sync = useCallback(async () => {
    await db.sync()
  }, [db])

  useEffect(() => {
    if (!callback) return
    let unsub: (() => void) | undefined
    try {
      unsub = db.onSync(callback)
    } catch {
      // Sync plugin not registered
    }
    return () => unsub?.()
  }, [db, callback])

  return { sync, status }
}

// ── DevTools Hooks & Components ──

export interface SyncQueueResult {
  snapshot: SyncQueueSnapshot | null
  loading: boolean
  error: Error | undefined
  refresh: () => Promise<void>
}

export function useSyncQueue(): SyncQueueResult {
  const db = useDatabase()
  const [snapshot, setSnapshot] = useState<SyncQueueSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | undefined>()

  async function refresh() {
    setLoading(true)
    setError(undefined)
    try {
      const result = await inspectSyncQueue(db)
      setSnapshot(result)
    } catch (e) {
      setError(e as Error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()

    const unsub = db.onSync(() => {
      refresh()
    })

    return () => {
      unsub()
    }
  }, [db])

  return { snapshot, loading, error, refresh }
}

export function SyncDevPanel({
  maxEvents = 50,
}: { maxEvents?: number } = {}): React.ReactElement | null {
  const db = useDatabase()
  const { snapshot, loading, refresh } = useSyncQueue()
  const [eventLog, setEventLog] = useState<ReturnType<typeof createSyncEventLog> | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    const log = createSyncEventLog(db, maxEvents)
    setEventLog(log)
    return () => log.stop()
  }, [db, maxEvents])

  const handleRetry = async () => {
    setRetrying(true)
    try {
      const count = await retryFailedSync(db)
      await refresh()
      console.log(`[ctrodb] Retried ${count} failed changes`)
    } finally {
      setRetrying(false)
    }
  }

  if (loading) {
    return createElement("div", { style: panelStyle }, "Loading sync queue...")
  }

  const stats = snapshot?.stats
  const latestEvents = eventLog?.events ?? []
  const recentEvents = latestEvents.slice(-maxEvents)

  return createElement(
    "div",
    { style: panelStyle },
    createElement("h3", { style: headingStyle }, "Sync Queue"),
    stats
      ? createElement(
          "ul",
          { style: listStyle },
          createElement("li", null, `Total: ${stats.total}`),
          createElement(
            "li",
            { style: stats.pending > 0 ? warnStyle : undefined },
            `Pending: ${stats.pending}`,
          ),
          createElement("li", null, `Syncing: ${stats.syncing}`),
          createElement("li", null, `Committed: ${stats.committed}`),
          createElement(
            "li",
            { style: stats.failed > 0 ? errorStyle : undefined },
            `Failed: ${stats.failed}`,
          ),
        )
      : null,
    stats && stats.failed > 0
      ? createElement(
          "button",
          {
            onClick: handleRetry,
            disabled: retrying,
            style: btnStyle,
          },
          retrying ? "Retrying..." : "Retry Failed",
        )
      : null,
    createElement("h3", { style: headingStyle }, "Sync Events"),
    recentEvents.length === 0
      ? createElement("p", { style: mutedStyle }, "No events yet")
      : createElement(
          "ul",
          { style: listStyle },
          ...recentEvents
            .map((ev) =>
              createElement(
                "li",
                { key: ev.timestamp, style: evStyle(ev.phase) },
                `${ev.phase} ${ev.changes != null ? `(${ev.changes})` : ""} — ${new Date(ev.timestamp).toLocaleTimeString()}`,
              ),
            )
            .reverse(),
        ),
  )
}

const panelStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  padding: 12,
  background: "#1a1a2e",
  color: "#e0e0e0",
  borderRadius: 8,
  maxHeight: 400,
  overflow: "auto",
}

const headingStyle: React.CSSProperties = {
  margin: "8px 0 4px",
  fontSize: 14,
  fontWeight: 700,
}

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0 0 8px",
  lineHeight: 1.6,
}

const warnStyle: React.CSSProperties = { color: "#f0c040" }
const errorStyle: React.CSSProperties = { color: "#e05050" }
const mutedStyle: React.CSSProperties = { color: "#888", fontSize: 11 }

const btnStyle: React.CSSProperties = {
  padding: "4px 12px",
  background: "#e05050",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  marginBottom: 8,
}

function evStyle(phase: string): React.CSSProperties {
  switch (phase) {
    case "error":
      return { color: "#e05050" }
    case "conflict":
      return { color: "#f0c040" }
    case "complete":
      return { color: "#50e050" }
    default:
      return { color: "#88aaff" }
  }
}
