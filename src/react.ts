import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { Collection } from "./collection"
import type { Database } from "./database"
import type { ModelInstance } from "./model/index"
import type { QueryBuilder } from "./query/builder"
import type { RelationShapes } from "./schema-types"
import { createSyncEventLog, inspectSyncQueue, retryFailedSync } from "./sync/devtools"
import type { SyncEvent, SyncQueueSnapshot, SyncStatus } from "./sync/types"
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

/**
 * How long a change burst is coalesced for before refetching. One animation
 * frame's worth: imperceptible to users, but it turns N events into one query.
 */
const COALESCE_MS = 16

export interface QueryResult<T extends object, R extends RelationShapes = Record<never, never>> {
  data: ModelInstance<T, R>[]
  loading: boolean
  error: Error | undefined
}

export interface DocResult<T extends object, R extends RelationShapes = Record<never, never>> {
  data: ModelInstance<T, R> | undefined
  loading: boolean
  error: Error | undefined
}

export function useQuery<T extends object, R extends RelationShapes = Record<never, never>>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T, R>) => QueryBuilder<T, R>,
  deps: unknown[] = [],
): QueryResult<T, R> {
  const db = useDatabase()
  const [state, setState] = useState<{
    data: ModelInstance<T, R>[]
    loading: boolean
    error: Error | undefined
  }>({ data: [], loading: true, error: undefined })

  // Always run the newest query function without making the effect depend on
  // it: callers routinely pass an inline arrow, which would otherwise refetch
  // on every render.
  const queryFnRef = useRef(queryFn)
  queryFnRef.current = queryFn

  // `deps` is a caller-supplied array whose *length* may change between
  // renders. Spreading it into the dependency list (the previous behaviour)
  // makes React see a different array size and throw. Compare it separately and
  // feed the effect a fixed-size key instead.
  const depsRef = useRef<unknown[]>(deps)
  const [depsVersion, setDepsVersion] = useState(0)

  useEffect(() => {
    const previous = depsRef.current
    const changed =
      previous.length !== deps.length ||
      deps.some((value, index) => !Object.is(value, previous[index]))
    if (changed) {
      depsRef.current = deps
      setDepsVersion((version) => version + 1)
    }
  })

  // `depsVersion` is the trigger: the caller's `deps` array is compared in the
  // effect above and cannot be listed directly, because its length may change
  // between renders (which is the whole point of the version counter).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    const collection = db.collection<T>(collectionName) as unknown as Collection<T, R>
    let disposed = false
    let scheduled: ReturnType<typeof setTimeout> | null = null
    // Sequence number per request: a slow response must never overwrite data
    // from a newer query (audit M-16).
    let latestRequest = 0

    const run = (initial: boolean) => {
      const request = ++latestRequest

      if (initial) {
        setState((current) => ({ ...current, loading: true, error: undefined }))
      }

      let query = collection.query()
      if (queryFnRef.current) {
        query = queryFnRef.current(query)
      }

      query
        .fetch()
        .then((data) => {
          if (disposed || request !== latestRequest) return
          setState({ data, loading: false, error: undefined })
        })
        .catch((caught: unknown) => {
          if (disposed || request !== latestRequest) return
          setState((current) => ({
            ...current,
            loading: false,
            error: caught instanceof Error ? caught : new Error(String(caught)),
          }))
        })
    }

    run(true)

    const unsubscribe = db.on((event: ChangeEvent) => {
      if (event.collection !== collectionName) return

      // Coalesce bursts: a bulk import or a sync pull emits one event per
      // record, and each used to trigger its own full refetch.
      if (scheduled) clearTimeout(scheduled)
      scheduled = setTimeout(() => {
        scheduled = null
        run(false) // background refresh: keep the current data, no spinner
      }, COALESCE_MS)
    })

    return () => {
      disposed = true
      unsubscribe()
      if (scheduled) clearTimeout(scheduled)
    }
  }, [collectionName, db, depsVersion])

  return state
}

export function useDoc<T extends object, R extends RelationShapes = Record<never, never>>(
  collectionName: string,
  id: ID | undefined,
): DocResult<T, R> {
  const { data, loading, error } = useQuery<T, R>(collectionName, (q) => q.where("id", "==", id), [
    id,
  ])
  return { data: data[0], loading, error }
}

export function useMutation<T extends object, R extends RelationShapes = Record<never, never>>(
  collectionName: string,
): {
  create: (data: Omit<T, "id"> & { id?: ID }) => Promise<ModelInstance<T, R>>
  update: (id: ID, changes: Partial<T>) => Promise<ModelInstance<T, R>>
  delete: (id: ID) => Promise<void>
  loading: boolean
  error: Error | undefined
  reset: () => void
} {
  const db = useDatabase()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | undefined>()
  // Same reason as useQuery(): the collection carries the relation map `R`.
  const collection = useMemo(
    () => db.collection<T>(collectionName) as unknown as Collection<T, R>,
    [db, collectionName],
  )

  const create = useCallback(
    async (data: Omit<T, "id"> & { id?: ID }) => {
      setLoading(true)
      setError(undefined)
      try {
        return await collection.create(data)
      } catch (e) {
        setError(e as Error)
        throw e
      } finally {
        setLoading(false)
      }
    },
    [collection],
  )

  const update = useCallback(
    async (id: ID, changes: Partial<T>) => {
      setLoading(true)
      setError(undefined)
      try {
        return await collection.update(id, changes)
      } catch (e) {
        setError(e as Error)
        throw e
      } finally {
        setLoading(false)
      }
    },
    [collection],
  )

  const del = useCallback(
    async (id: ID) => {
      setLoading(true)
      setError(undefined)
      try {
        await collection.delete(id)
      } catch (e) {
        setError(e as Error)
        throw e
      } finally {
        setLoading(false)
      }
    },
    [collection],
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

  const refresh = useCallback(async () => {
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
  }, [db])

  useEffect(() => {
    refresh()

    const unsub = db.onSync(() => {
      refresh()
    })

    return () => {
      unsub()
    }
  }, [db, refresh])

  return { snapshot, loading, error, refresh }
}

export function SyncDevPanel({
  maxEvents = 50,
}: {
  maxEvents?: number
} = {}): React.ReactElement | null {
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
            type: "button",
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
