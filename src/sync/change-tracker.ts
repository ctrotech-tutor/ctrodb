import { equalityRange } from "../query/range"
import type { ID, StorageAdapter } from "../types"
import type { SyncChangeRecord, SyncChangeStatus, SyncChangeType } from "./types"

export const SYNC_STORE = "_ctrodb_sync_changes"

/**
 * Identifies this JavaScript context (tab / worker / process).
 *
 * Writes broadcast their origin so a receiver can tell "another tab changed
 * this" from "I changed this". Without it, every local write echoed back into
 * the same tab's engine, which emitted a bogus push phase, re-emitted the
 * change event and scheduled a redundant sync (audit M-09).
 */
export const TAB_ID: string = (() => {
  try {
    return crypto.randomUUID()
  } catch {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
})()

let changeChannel: BroadcastChannel | null = null

/** Lazily create one channel for the whole context instead of one per write. */
function getChangeChannel(): BroadcastChannel | null {
  if (changeChannel) return changeChannel
  try {
    changeChannel = new BroadcastChannel("ctrodb:sync")
    return changeChannel
  } catch {
    return null // BroadcastChannel unavailable (older runtimes)
  }
}

/** Release the shared channel; called from the sync engine's destroy(). */
export function closeChangeChannel(): void {
  if (!changeChannel) return
  changeChannel.onmessage = null
  changeChannel.close()
  changeChannel = null
}

/**
 * Persistent queue of not-yet-acknowledged local writes.
 *
 * Status lookups go through the adapter's index-scan contract using a
 * storage-neutral range, so the tracker works identically on memory (Node) and
 * IndexedDB (browser).
 */
export class ChangeTracker {
  readonly storeName = SYNC_STORE

  readonly #adapter: StorageAdapter

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter
  }

  /** Recover records left in `syncing` by a crash or a killed tab. */
  async init(): Promise<void> {
    const syncing = await this.byStatus("syncing")
    for (const change of syncing) {
      await this.#adapter.update(this.storeName, change.id, {
        status: "pending",
        retries: (change.retries ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      } as Record<string, unknown>)
    }
  }

  async append(
    type: SyncChangeType,
    collection: string,
    recordId: ID,
    data: Record<string, unknown> | null,
    prevData?: Record<string, unknown> | null,
  ): Promise<string> {
    let id: string
    try {
      id = crypto.randomUUID()
    } catch {
      id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    }
    const now = new Date().toISOString()
    const record: SyncChangeRecord = {
      id,
      collection,
      recordId,
      type,
      data,
      prevData: prevData ?? null,
      timestamp: now,
      status: "pending",
      retries: 0,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.#adapter.create(this.storeName, record as unknown as Record<string, unknown>)

    // Announce the write to *other* contexts. The shared channel is reused, and
    // the message carries this context's id so receivers can ignore their own
    // echo (audit M-09).
    getChangeChannel()?.postMessage({
      type: "change",
      origin: TAB_ID,
      collection,
      recordId,
      changeType: type,
    })

    return id
  }

  /**
   * Changes that still need to reach the server, oldest first.
   *
   * Failed changes are included so a transient failure is retried; the sync
   * engine decides when a change has exhausted its retries.
   */
  async getPending(): Promise<SyncChangeRecord[]> {
    const [pending, failed] = await Promise.all([this.byStatus("pending"), this.byStatus("failed")])
    return [...pending, ...failed].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  async byStatus(status: SyncChangeStatus): Promise<SyncChangeRecord[]> {
    return (await this.#adapter.scanIndex(
      this.storeName,
      "status",
      equalityRange(status),
      [],
    )) as SyncChangeRecord[]
  }

  async getById(id: string): Promise<SyncChangeRecord | undefined> {
    const record = await this.#adapter.findById(this.storeName, id)
    return record as SyncChangeRecord | undefined
  }

  async markSyncing(ids: string[]): Promise<void> {
    const now = new Date().toISOString()
    const done: string[] = []
    try {
      for (const id of ids) {
        await this.#adapter.update(this.storeName, id, {
          status: "syncing",
          updatedAt: now,
        } as Record<string, unknown>)
        done.push(id)
      }
    } catch (error) {
      // Rollback already-marked IDs on partial failure
      for (const id of done) {
        await this.#adapter
          .update(this.storeName, id, {
            status: "pending",
            updatedAt: new Date().toISOString(),
          } as Record<string, unknown>)
          .catch(() => {})
      }
      throw error
    }
  }

  async markCommitted(id: string, metadata?: { serverTimestamp?: string }): Promise<void> {
    await this.#adapter.update(this.storeName, id, {
      status: "committed",
      updatedAt: new Date().toISOString(),
      ...(metadata?.serverTimestamp
        ? ({ serverTimestamp: metadata.serverTimestamp } as Record<string, unknown>)
        : {}),
    } as Record<string, unknown>)
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    const existing = (await this.#adapter.findById(this.storeName, id)) as
      | SyncChangeRecord
      | undefined
    if (!existing) return
    await this.#adapter.update(this.storeName, id, {
      status: "failed",
      retries: (existing.retries ?? 0) + 1,
      errorMessage,
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>)
  }

  async markPending(id: string, options?: { retries?: number }): Promise<void> {
    await this.#adapter.update(this.storeName, id, {
      status: "pending",
      updatedAt: new Date().toISOString(),
      ...(options?.retries !== undefined ? { retries: options.retries } : {}),
    } as Record<string, unknown>)
  }

  async countByStatus(status: SyncChangeStatus): Promise<number> {
    return (await this.byStatus(status)).length
  }

  async countPending(): Promise<number> {
    const [pending, failed] = await Promise.all([this.byStatus("pending"), this.byStatus("failed")])
    return pending.length + failed.length
  }

  async removeCommitted(): Promise<number> {
    const committed = await this.byStatus("committed")
    const ids = committed.map((c) => c.id)
    if (ids.length > 0) {
      await this.#adapter.deleteMany(this.storeName, ids)
    }
    return ids.length
  }

  async getAll(): Promise<SyncChangeRecord[]> {
    return (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
  }

  async getFailed(): Promise<SyncChangeRecord[]> {
    return this.byStatus("failed")
  }
}
