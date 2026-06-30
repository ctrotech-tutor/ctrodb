import type { ServerChange, SyncChangeType } from "./types"

export interface StoredRecord {
  id: string | number
  [key: string]: unknown
}

export class SyncStore {
  // collection -> recordId -> record
  readonly #records = new Map<string, Map<string | number, StoredRecord>>()
  // Ordered change log for pull cursor pagination
  readonly #changes: ServerChange[] = []
  #changeCounter = 0

  get changeCount(): number {
    return this.#changes.length
  }

  getRecord(collection: string, recordId: string | number): StoredRecord | undefined {
    const col = this.#records.get(collection)
    return col?.get(recordId)
  }

  getAllRecords(collection: string): StoredRecord[] {
    const col = this.#records.get(collection)
    return col ? Array.from(col.values()) : []
  }

  upsertRecord(collection: string, recordId: string | number, data: Record<string, unknown>): void {
    let col = this.#records.get(collection)
    if (!col) {
      col = new Map()
      this.#records.set(collection, col)
    }
    col.set(recordId, { id: recordId, ...data } as StoredRecord)
  }

  deleteRecord(collection: string, recordId: string | number): void {
    const col = this.#records.get(collection)
    col?.delete(recordId)
  }

  appendChange(
    collection: string,
    recordId: string | number,
    type: SyncChangeType,
    data: Record<string, unknown> | null,
  ): ServerChange {
    this.#changeCounter++
    const change: ServerChange = {
      id: `svr_${this.#changeCounter}`,
      collection,
      recordId,
      type,
      data,
      timestamp: new Date().toISOString(),
    }
    this.#changes.push(change)
    return change
  }

  getChanges(
    cursor: string | null,
    collections: string[] | undefined,
    batchSize: number,
  ): { changes: ServerChange[]; cursor: string | null; hasMore: boolean } {
    const cursorIndex = cursor
      ? this.#changes.findIndex((c) => c.id === cursor)
      : -1

    const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0

    const raw = this.#changes.slice(startIndex, startIndex + batchSize)

    const filtered = collections
      ? raw.filter((c) => collections.includes(c.collection))
      : raw

    const nextCursor =
      filtered.length > 0
        ? filtered[filtered.length - 1]!.id
        : cursor

    const hasMore = startIndex + batchSize < this.#changes.length

    return { changes: filtered, cursor: nextCursor, hasMore }
  }
}
