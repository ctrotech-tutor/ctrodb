import type { ID, StorageAdapter } from "../types";
import type {
  SyncChangeRecord,
  SyncChangeStatus,
  SyncChangeType,
} from "./types";

export const SYNC_STORE = "_ctrodb_sync_changes";

export class ChangeTracker {
  readonly storeName = SYNC_STORE;

  readonly #adapter: StorageAdapter;

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter;
  }

  async init(): Promise<void> {
    const syncing = (await this.#adapter.scanIndex(
      this.storeName,
      "status",
      IDBKeyRange.only("syncing"),
      [],
    )) as SyncChangeRecord[];
    for (const change of syncing) {
      await this.#adapter.update(this.storeName, change.id, {
        status: "pending",
        retries: (change.retries ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      } as Record<string, unknown>);
    }
  }

  async append(
    type: SyncChangeType,
    collection: string,
    recordId: ID,
    data: Record<string, unknown> | null,
    prevData?: Record<string, unknown> | null,
  ): Promise<string> {
    let id: string;
    try {
      id = crypto.randomUUID();
    } catch {
      id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    const now = new Date().toISOString();
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
    };
    await this.#adapter.create(
      this.storeName,
      record as unknown as Record<string, unknown>,
    );

    // Broadcast change to other tabs (graceful fallback if BroadcastChannel unavailable)
    try {
      const channel = new BroadcastChannel("ctrodb:sync");
      channel.postMessage({
        type: "change",
        collection,
        recordId,
        changeType: type,
      });
      channel.close();
    } catch {
      // BroadcastChannel unavailable (Node.js, older browsers)
    }

    return id;
  }

  async getPending(): Promise<SyncChangeRecord[]> {
    const [pending, failed] = await Promise.all([
      this.#adapter.scanIndex(
        this.storeName,
        "status",
        IDBKeyRange.only("pending"),
        [],
      ) as Promise<SyncChangeRecord[]>,
      this.#adapter.scanIndex(
        this.storeName,
        "status",
        IDBKeyRange.only("failed"),
        [],
      ) as Promise<SyncChangeRecord[]>,
    ]);
    return [...pending, ...failed].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
  }

  async getById(id: string): Promise<SyncChangeRecord | undefined> {
    const record = await this.#adapter.findById(this.storeName, id);
    return record as SyncChangeRecord | undefined;
  }

  async markSyncing(ids: string[]): Promise<void> {
    const now = new Date().toISOString();
    const done: string[] = [];
    try {
      for (const id of ids) {
        await this.#adapter.update(this.storeName, id, {
          status: "syncing",
          updatedAt: now,
        } as Record<string, unknown>);
        done.push(id);
      }
    } catch (error) {
      // Rollback already-marked IDs on partial failure
      for (const id of done) {
        await this.#adapter
          .update(this.storeName, id, {
            status: "pending",
            updatedAt: new Date().toISOString(),
          } as Record<string, unknown>)
          .catch(() => {});
      }
      throw error;
    }
  }

  async markCommitted(
    id: string,
    metadata?: { serverTimestamp?: string },
  ): Promise<void> {
    await this.#adapter.update(this.storeName, id, {
      status: "committed",
      updatedAt: new Date().toISOString(),
      ...(metadata?.serverTimestamp
        ? ({ serverTimestamp: metadata.serverTimestamp } as Record<
            string,
            unknown
          >)
        : {}),
    } as Record<string, unknown>);
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    const existing = (await this.#adapter.findById(this.storeName, id)) as
      | SyncChangeRecord
      | undefined;
    if (!existing) return;
    await this.#adapter.update(this.storeName, id, {
      status: "failed",
      retries: (existing.retries ?? 0) + 1,
      errorMessage,
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>);
  }

  async markPending(id: string): Promise<void> {
    await this.#adapter.update(this.storeName, id, {
      status: "pending",
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>);
  }

  async countByStatus(status: SyncChangeStatus): Promise<number> {
    const records = (await this.#adapter.scanIndex(
      this.storeName,
      "status",
      IDBKeyRange.only(status),
      [],
    )) as SyncChangeRecord[];
    return records.length;
  }

  async countPending(): Promise<number> {
    const [pending, failed] = await Promise.all([
      this.#adapter.scanIndex(
        this.storeName,
        "status",
        IDBKeyRange.only("pending"),
        [],
      ) as Promise<SyncChangeRecord[]>,
      this.#adapter.scanIndex(
        this.storeName,
        "status",
        IDBKeyRange.only("failed"),
        [],
      ) as Promise<SyncChangeRecord[]>,
    ]);
    return pending.length + failed.length;
  }

  async removeCommitted(): Promise<number> {
    const committed = (await this.#adapter.scanIndex(
      this.storeName,
      "status",
      IDBKeyRange.only("committed"),
      [],
    )) as SyncChangeRecord[];
    const ids = committed.map((c) => c.id);
    if (ids.length > 0) {
      await this.#adapter.deleteMany(this.storeName, ids);
    }
    return ids.length;
  }

  async getAll(): Promise<SyncChangeRecord[]> {
    return (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[];
  }

  async getFailed(): Promise<SyncChangeRecord[]> {
    return (await this.#adapter.scanIndex(
      this.storeName,
      "status",
      IDBKeyRange.only("failed"),
      [],
    )) as SyncChangeRecord[];
  }
}
