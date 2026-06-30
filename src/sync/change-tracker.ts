import type { ID, StorageAdapter } from "../types"
import type { SyncChangeRecord, SyncChangeStatus, SyncChangeType } from "./types"

export const SYNC_STORE = "_ctrodb_sync_changes"

export class ChangeTracker {
  readonly storeName = SYNC_STORE

  readonly #adapter: StorageAdapter

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter
  }

  async init(): Promise<void> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    for (const change of all) {
      if (change.status === "syncing") {
        await this.#adapter.update(this.storeName, change.id, {
          status: "pending",
          retries: (change.retries ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        } as Record<string, unknown>)
      }
    }
  }

  async append(
    type: SyncChangeType,
    collection: string,
    recordId: ID,
    data: Record<string, unknown> | null,
    prevData?: Record<string, unknown> | null,
  ): Promise<string> {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
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
    return id
  }

  async getPending(): Promise<SyncChangeRecord[]> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    return all
      .filter((c) => c.status === "pending" || c.status === "failed")
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  async getById(id: string): Promise<SyncChangeRecord | undefined> {
    const record = await this.#adapter.findById(this.storeName, id)
    return record as SyncChangeRecord | undefined
  }

  async markSyncing(ids: string[]): Promise<void> {
    const now = new Date().toISOString()
    for (const id of ids) {
      await this.#adapter.update(this.storeName, id, {
        status: "syncing",
        updatedAt: now,
      } as Record<string, unknown>)
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

  async markPending(id: string): Promise<void> {
    await this.#adapter.update(this.storeName, id, {
      status: "pending",
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>)
  }

  async countByStatus(status: SyncChangeStatus): Promise<number> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    return all.filter((c) => c.status === status).length
  }

  async countPending(): Promise<number> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    return all.filter((c) => c.status === "pending" || c.status === "failed").length
  }

  async removeCommitted(): Promise<number> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    const committed = all.filter((c) => c.status === "committed")
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
    const all = await this.getAll()
    return all.filter((c) => c.status === "failed")
  }
}
