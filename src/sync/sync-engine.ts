import type { Database } from "../database"
import type { ChangeEvent, ID, StorageAdapter } from "../types"
import { ChangeTracker } from "./change-tracker"
import { ConflictResolverEngine } from "./conflict-resolver"
import type {
  ConflictStrategy,
  SyncConflict,
  SyncEvent,
  SyncPhase,
  SyncPluginConfig,
  SyncProgress,
  SyncPullResult,
  SyncPushResult,
  SyncStatus,
  SyncTransport,
} from "./types"

const DEFAULT_PUSH_BATCH = 50
const DEFAULT_PULL_BATCH = 100
const DEFAULT_RETRY_MAX = 10
const DEFAULT_INTERVAL_MS = 30000
const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_MAX_BACKOFF_MS = 300000
const INITIAL_BACKOFF_MS = 1000
const MAX_PULL_PAGES = 1000
const CIRCUIT_BREAKER_THRESHOLD = 50

type AdapterWithMetadata = StorageAdapter & {
  getMetadata(key: string): Promise<unknown>
  setMetadata(key: string, value: unknown): Promise<void>
}

export class SyncEngine {
  readonly #tracker: ChangeTracker
  readonly #resolver: ConflictResolverEngine
  readonly #transport: SyncTransport
  readonly #config: {
    transport: SyncTransport
    strategy: ConflictStrategy
    collections: string[]
    pushBatchSize: number
    pullBatchSize: number
    retryMaxAttempts: number
    autoSync: boolean
    autoIntervalMs: number
    autoDebounceMs: number
  }

  readonly #adapter: AdapterWithMetadata

  readonly #db: Database

  #broadcastChannel: BroadcastChannel | null = null
  #handleOnline: (() => void) | null = null
  #handleOffline: (() => void) | null = null

  #isSyncing = false
  #isConnected = false
  #lastSyncAt: string | null = null
  #lastError: string | null = null
  #lastPullCursor: string | null = null
  #backoffDelay = INITIAL_BACKOFF_MS

  #autoSyncTimer: ReturnType<typeof setInterval> | null = null
  #autoSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null
  #backoffTimer: ReturnType<typeof setTimeout> | null = null
  #abortController: AbortController | null = null

  readonly #eventCallbacks: Set<(event: SyncEvent) => void> = new Set()

  #consecutiveFailures = 0
  #cachedPendingCount = 0
  #cachedFailedCount = 0

  constructor(_db: Database, config: SyncPluginConfig) {
    const adapter = _db._getAdapter() as AdapterWithMetadata

    this.#db = _db
    this.#adapter = adapter
    this.#tracker = new ChangeTracker(adapter)
    this.#resolver = new ConflictResolverEngine(config.strategy, config.conflictResolver)
    this.#transport = config.transport

    const autoSync = config.autoSync
    const autoSyncObj = typeof autoSync === "object" ? autoSync : {}

    this.#config = {
      transport: config.transport,
      strategy: config.strategy ?? "lww",
      collections: config.collections ?? [],
      pushBatchSize: config.pushBatchSize ?? DEFAULT_PUSH_BATCH,
      pullBatchSize: config.pullBatchSize ?? DEFAULT_PULL_BATCH,
      retryMaxAttempts: config.retryMaxAttempts ?? DEFAULT_RETRY_MAX,
      autoSync: autoSync === true || typeof autoSync === "object",
      autoIntervalMs: autoSyncObj.intervalMs ?? DEFAULT_INTERVAL_MS,
      autoDebounceMs: autoSyncObj.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    }
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    await this.#tracker.init()

    this.#lastPullCursor = (await this.#adapter.getMetadata("sync:lastPullCursor")) as string | null
    this.#lastSyncAt = (await this.#adapter.getMetadata("sync:lastSyncAt")) as string | null

    if (this.#transport.connect) {
      try {
        await this.#transport.connect()
        this.#isConnected = this.#transport.isConnected?.() ?? true
      } catch {
        this.#isConnected = false
      }
    } else {
      this.#isConnected = true
    }

    // ── Subscribe to cross-tab change broadcasts ──
    try {
      this.#broadcastChannel = new BroadcastChannel("ctrodb:sync")
      this.#broadcastChannel.onmessage = (event: MessageEvent) => {
        if (event.data?.type === "change") {
          this.#emit({ phase: "push" } as {
            phase: SyncPhase
            progress?: SyncProgress
            error?: Error
          })
          this.#db._emit({
            type: event.data.changeType,
            collection: event.data.collection,
            recordId: event.data.recordId,
          } as ChangeEvent)
          this.triggerSync()
        }
      }
    } catch {
      this.#broadcastChannel = null
    }

    // ── Online/offline detection ──
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.#handleOnline = () => this.setConnected(true)
      this.#handleOffline = () => this.setConnected(false)
      window.addEventListener("online", this.#handleOnline)
      window.addEventListener("offline", this.#handleOffline)
    }

    if (this.#config.autoSync) {
      this.#startAutoSync()
    }
  }

  async destroy(): Promise<void> {
    this.#stopAutoSync()
    this.#cancelBackoff()
    this.#clearDebounce()

    // ── Cleanup BroadcastChannel ──
    if (this.#broadcastChannel) {
      this.#broadcastChannel.onmessage = null
      this.#broadcastChannel.close()
      this.#broadcastChannel = null
    }

    // ── Remove online/offline listeners ──
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      if (this.#handleOnline) {
        window.removeEventListener("online", this.#handleOnline)
        this.#handleOnline = null
      }
      if (this.#handleOffline) {
        window.removeEventListener("offline", this.#handleOffline)
        this.#handleOffline = null
      }
    }

    if (this.#transport.disconnect) {
      try {
        await this.#transport.disconnect()
      } catch {
        // Silently ignore disconnect errors
      }
    }
    this.#isConnected = false
  }

  // ── Status ──

  get status(): SyncStatus {
    return {
      isSyncing: this.#isSyncing,
      isConnected: this.#isConnected,
      lastSyncAt: this.#lastSyncAt,
      pendingChanges: this.#cachedPendingCount,
      failedChanges: this.#cachedFailedCount,
      lastError: this.#lastError,
    }
  }

  async getPendingCount(): Promise<number> {
    this.#cachedPendingCount = await this.#tracker.countPending()
    return this.#cachedPendingCount
  }

  async getFailedCount(): Promise<number> {
    this.#cachedFailedCount = await this.#tracker.countByStatus("failed")
    return this.#cachedFailedCount
  }

  async #refreshCounts(): Promise<void> {
    this.#cachedPendingCount = await this.#tracker.countPending()
    this.#cachedFailedCount = await this.#tracker.countByStatus("failed")
  }

  // ── Main sync cycle ──

  async sync(): Promise<void> {
    if (this.#isSyncing) return

    this.#isSyncing = true
    this.#abortController = new AbortController()

    try {
      const signal = this.#abortController.signal

      this.#emit({ phase: "push" })

      const pushProgress = await this.#pushChanges(signal)

      if (pushProgress.conflicts > 0) {
        this.#emit({ phase: "conflict", progress: pushProgress })
      }

      this.#emit({ phase: "pull", progress: pushProgress })

      const pullProgress = await this.#pullChanges(signal)

      const total: SyncProgress = {
        pushed: pushProgress.pushed,
        pulled: pullProgress.pulled,
        conflicts: pushProgress.conflicts,
        failed: pushProgress.failed + pullProgress.failed,
      }

      this.#lastSyncAt = new Date().toISOString()
      this.#lastError = null
      this.#backoffDelay = INITIAL_BACKOFF_MS
      this.#consecutiveFailures = 0

      await this.#adapter.setMetadata("sync:lastSyncAt", this.#lastSyncAt)
      if (this.#lastPullCursor) {
        await this.#adapter.setMetadata("sync:lastPullCursor", this.#lastPullCursor)
      }

      await this.#tracker.removeCommitted()

      await this.#refreshCounts()

      this.#emit({ phase: "complete", progress: total })
    } catch (error) {
      const err = error as Error

      // Don't treat user-cancelled sync (AbortError) as a failure
      if (err.name === "AbortError") {
        this.#emit({ phase: "error", error: err })
        return
      }

      this.#lastError = err.message ?? "Unknown sync error"
      this.#consecutiveFailures++

      this.#emit({
        phase: "error",
        error: err,
      })

      if (this.#config.autoSync && this.#consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD) {
        this.#scheduleBackoff()
      }
    } finally {
      this.#isSyncing = false
      this.#abortController = null
    }
  }

  // ── Push ──

  async #pushChanges(signal: AbortSignal): Promise<SyncProgress> {
    const pending = await this.#tracker.getPending()

    if (pending.length === 0) {
      return { pushed: 0, pulled: 0, conflicts: 0, failed: 0 }
    }

    if (signal.aborted) {
      throw new DOMException("Sync aborted", "AbortError")
    }

    const batch = pending.slice(0, this.#config.pushBatchSize)
    const batchIds = batch.map((c) => c.id)

    await this.#tracker.markSyncing(batchIds)

    let result: SyncPushResult
    try {
      result = await this.#transport.push(batch, { signal })
    } catch (error) {
      for (const id of batchIds) {
        await this.#tracker.markPending(id)
      }
      throw error
    }

    for (const accepted of result.accepted) {
      await this.#tracker.markCommitted(accepted.id, {
        serverTimestamp: accepted.serverTimestamp,
      })
    }

    for (const conflict of result.conflicts) {
      await this.#resolveConflict(conflict)
    }

    for (const err of result.errors) {
      await this.#tracker.markFailed(err.id, err.error)
    }

    return {
      pushed: result.accepted.length,
      pulled: 0,
      conflicts: result.conflicts.length,
      failed: result.errors.length,
    }
  }

  // ── Conflict resolution (from push) ──

  async #resolveConflict(conflict: SyncConflict): Promise<void> {
    const resolution = await this.#resolver.resolve(conflict)

    switch (resolution.resolution) {
      case "local":
        await this.#tracker.markCommitted(conflict.changeId, {
          serverTimestamp: conflict.remoteTimestamp,
        })
        break

      case "remote": {
        const adapter = this.#adapter
        const remoteData = conflict.remote

        const existing = await adapter.findById(conflict.collection, conflict.recordId)
        if (existing && remoteData) {
          await adapter.update(conflict.collection, conflict.recordId, {
            ...remoteData,
          } as Record<string, unknown>)
        } else if (!existing && remoteData) {
          await adapter.create(conflict.collection, {
            id: conflict.recordId,
            ...remoteData,
          } as Record<string, unknown>)
        } else {
          if (existing) {
            await adapter.delete(conflict.collection, conflict.recordId)
          }
        }

        await this.#tracker.markCommitted(conflict.changeId, {
          serverTimestamp: conflict.remoteTimestamp,
        })
        break
      }

      case "merged": {
        if (resolution.merged) {
          const adapter = this.#adapter
          const existing = await adapter.findById(conflict.collection, conflict.recordId)
          if (existing) {
            await adapter.update(conflict.collection, conflict.recordId, {
              ...resolution.merged,
            } as Record<string, unknown>)
          } else {
            await adapter.create(conflict.collection, {
              id: conflict.recordId,
              ...resolution.merged,
            } as Record<string, unknown>)
          }
        }

        await this.#tracker.markCommitted(conflict.changeId, {
          serverTimestamp: conflict.remoteTimestamp,
        })
        break
      }
    }
  }

  // ── Pull ──

  async #pullChanges(signal: AbortSignal): Promise<{ pulled: number; failed: number }> {
    let pulled = 0
    let hasMore = true
    let cursor = this.#lastPullCursor
    let lastCursor = cursor
    let pages = 0

    while (hasMore) {
      if (signal.aborted) {
        throw new DOMException("Sync aborted", "AbortError")
      }

      if (pages >= MAX_PULL_PAGES) {
        throw new Error(
          `Pull exceeded max pages (${MAX_PULL_PAGES}). Possible server infinite loop.`,
        )
      }

      const result: SyncPullResult = await this.#transport.pull({
        cursor,
        collections: this.#config.collections.length > 0 ? this.#config.collections : undefined,
        batchSize: this.#config.pullBatchSize,
        signal,
      })

      for (const change of result.changes) {
        await this.#applyRemoteChange(change)
      }

      pulled += result.changes.length
      lastCursor = result.cursor ?? lastCursor
      cursor = result.cursor
      hasMore = result.hasMore && result.changes.length > 0
      pages++
    }

    this.#lastPullCursor = lastCursor
    return { pulled, failed: 0 }
  }

  async #applyRemoteChange(change: {
    id: string
    collection: string
    recordId: ID
    type: "create" | "update" | "delete"
    data: Record<string, unknown> | null
    timestamp: string
  }): Promise<void> {
    const adapter = this.#adapter
    const local = await adapter.findById(change.collection, change.recordId)

    switch (change.type) {
      case "create":
      case "update": {
        if (change.data === null) break

        if (local) {
          await adapter.update(change.collection, change.recordId, {
            ...change.data,
          } as Record<string, unknown>)
        } else {
          await adapter.create(change.collection, {
            id: change.recordId,
            ...change.data,
          } as Record<string, unknown>)
        }
        break
      }

      case "delete": {
        if (local) {
          await adapter.delete(change.collection, change.recordId)
        }
        break
      }
    }
  }

  // ── Auto-sync ──

  #startAutoSync(): void {
    this.#autoSyncTimer = setInterval(() => {
      this.sync()
    }, this.#config.autoIntervalMs)
  }

  #stopAutoSync(): void {
    if (this.#autoSyncTimer !== null) {
      clearInterval(this.#autoSyncTimer)
      this.#autoSyncTimer = null
    }
  }

  triggerSync(): void {
    if (!this.#config.autoSync) return

    if (this.#autoSyncDebounceTimer !== null) {
      clearTimeout(this.#autoSyncDebounceTimer)
    }

    this.#autoSyncDebounceTimer = setTimeout(() => {
      this.#autoSyncDebounceTimer = null
      this.sync()
    }, this.#config.autoDebounceMs)
  }

  #clearDebounce(): void {
    if (this.#autoSyncDebounceTimer !== null) {
      clearTimeout(this.#autoSyncDebounceTimer)
      this.#autoSyncDebounceTimer = null
    }
  }

  // ── Backoff ──

  #scheduleBackoff(): void {
    if (this.#backoffTimer !== null) return

    const maxDelay = DEFAULT_MAX_BACKOFF_MS
    const delay = Math.min(this.#backoffDelay, maxDelay)
    const jitter = delay * (0.75 + Math.random() * 0.5)

    this.#backoffTimer = setTimeout(() => {
      this.#backoffTimer = null
      this.#backoffDelay = Math.min(this.#backoffDelay * 2, maxDelay)
      this.sync()
    }, jitter)
  }

  #cancelBackoff(): void {
    if (this.#backoffTimer !== null) {
      clearTimeout(this.#backoffTimer)
      this.#backoffTimer = null
    }
  }

  // ── Connectivity ──

  setConnected(connected: boolean): void {
    const wasOffline = !this.#isConnected
    this.#isConnected = connected

    if (connected && wasOffline && this.#config.autoSync) {
      this.sync()
    }
  }

  // ── Events ──

  onEvent(callback: (event: SyncEvent) => void): () => void {
    this.#eventCallbacks.add(callback)
    return () => {
      this.#eventCallbacks.delete(callback)
    }
  }

  #emit(event: { phase: SyncPhase; progress?: SyncProgress; error?: Error }): void {
    const fullEvent: SyncEvent = {
      type: "sync",
      phase: event.phase,
      timestamp: new Date().toISOString(),
      progress: event.progress,
      error: event.error,
    }

    for (const cb of this.#eventCallbacks) {
      try {
        cb(fullEvent)
      } catch {
        // Subscriber errors must not crash the engine
      }
    }
  }
}
