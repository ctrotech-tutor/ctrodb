import type { Database } from "../database"
import type { StorageAdapter } from "../types"
import { ChangeTracker, SYNC_STORE } from "./change-tracker"
import type {
  SyncChangeRecord,
  SyncEvent,
  SyncEventLogEntry,
  SyncQueueSnapshot,
  SyncQueueStats,
} from "./types"

function assertSyncEngine(db: Database): void {
  const plugin = db.plugin("sync") as { _engine?: { sync(): Promise<void> } } | undefined
  if (!plugin?._engine) {
    throw new Error("Sync plugin not registered. Ensure syncPlugin() is added to Database config.")
  }
}

export function createSyncEventLog(
  db: Database,
  maxSize = 100,
): { events: SyncEventLogEntry[]; stop: () => void } {
  const events: SyncEventLogEntry[] = []

  const unsub = db.onSync((event: SyncEvent) => {
    events.push({
      phase: event.phase,
      changes: event.changes,
      conflicts: event.conflicts?.length,
      progress: event.progress,
      error: event.error,
      timestamp: event.timestamp,
    })
    if (events.length > maxSize) {
      events.shift()
    }
  })

  return {
    events,
    stop: unsub,
  }
}

export async function inspectSyncQueue(db: Database): Promise<SyncQueueSnapshot> {
  assertSyncEngine(db)

  const adapter = db._getAdapter()
  const all = (await adapter.findAll(SYNC_STORE)) as SyncChangeRecord[]

  const pending = all.filter((c) => c.status === "pending")
  const syncing = all.filter((c) => c.status === "syncing")
  const committed = all.filter((c) => c.status === "committed")
  const failed = all.filter((c) => c.status === "failed")

  const stats: SyncQueueStats = {
    total: all.length,
    pending: pending.length,
    syncing: syncing.length,
    committed: committed.length,
    failed: failed.length,
  }

  return { pending, syncing, committed, failed, stats }
}

export async function retryFailedSync(db: Database): Promise<number> {
  assertSyncEngine(db)

  const tracker = new ChangeTracker(db._getAdapter())
  const failed = await tracker.getFailed()

  for (const change of failed) {
    await tracker.markPending(change.id)
  }

  const plugin = db.plugin("sync") as { _engine?: { sync(): Promise<void> } } | undefined
  if (plugin?._engine?.sync) {
    await plugin._engine.sync()
  }

  return failed.length
}

export async function clearCommittedSync(db: Database): Promise<number> {
  const tracker = new ChangeTracker(db._getAdapter())
  return tracker.removeCommitted()
}

export async function getSyncStats(db: Database): Promise<SyncQueueStats> {
  const snapshot = await inspectSyncQueue(db)
  return snapshot.stats
}

export async function compactSyncQueue(db: Database): Promise<number> {
  assertSyncEngine(db)

  const adapter: StorageAdapter = db._getAdapter()
  const all = (await adapter.findAll(SYNC_STORE)) as SyncChangeRecord[]
  const pending = all.filter((c) => c.status === "pending" || c.status === "failed")

  // Group by (collection, recordId)
  const groups = new Map<string, SyncChangeRecord[]>()
  for (const change of pending) {
    const key = `${change.collection}:${String(change.recordId)}`
    const group = groups.get(key)
    if (group) {
      group.push(change)
    } else {
      groups.set(key, [change])
    }
  }

  let removed = 0
  for (const [, changes] of groups) {
    if (changes.length > 1) {
      // Sort descending by timestamp — keep newest
      changes.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      for (let i = 1; i < changes.length; i++) {
        const candidate = changes[i]
        if (!candidate) continue
        // Re-fetch to ensure record is still pending/failed (not syncing/committed)
        const current = (await adapter.findById(SYNC_STORE, candidate.id)) as
          | SyncChangeRecord
          | undefined
        if (current && (current.status === "pending" || current.status === "failed")) {
          await adapter.delete(SYNC_STORE, candidate.id)
          removed++
        }
      }
    }
  }

  return removed
}
