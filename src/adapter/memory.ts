import { matchesWhere } from "../query/predicate"
import { compareQueryKeys, queryRangeContains } from "../query/range"
import type {
  ID,
  QueryCondition,
  QueryKey,
  QueryRange,
  SchemaConfig,
  StorageAdapter,
  TransactionCollection,
  TransactionContext,
} from "../types"

/**
 * Index entries are keyed by a tagged string so that `1` (number) and `"1"`
 * (string) never collide, mirroring IndexedDB's typed keys.
 */
function encodeIndexKey(value: unknown): string | null {
  if (typeof value === "string") return `s:${value}`
  if (typeof value === "number") return `n:${value}`
  if (value instanceof Date) return `d:${value.getTime()}`
  return null
}

function decodeIndexKey(key: string): QueryKey {
  const payload = key.slice(2)
  switch (key[0]) {
    case "n":
      return Number(payload)
    case "d":
      return new Date(Number(payload))
    default:
      return payload
  }
}

interface SortedIndexKey {
  encoded: string
  value: QueryKey
}

export class MemoryAdapter implements StorageAdapter {
  readonly name = "memory"

  #data = new Map<string, Map<ID, Record<string, unknown>>>()

  #meta = new Map<string, unknown>()
  #connected = false
  /** Unique index fields per collection, mirroring what IndexedDB enforces. */
  #uniqueIndexes = new Map<string, string[]>()

  /**
   * Real index structures: collection → field → encoded key → record ids.
   *
   * `scanIndex` used to ignore the index and filter a full scan, which made an
   * indexed query *slower* than no index at all (measured 2.6x on 20k rows):
   * every indexed read paid for a full copy of the collection plus the filter.
   */
  #indexes = new Map<string, Map<string, Map<string, Set<ID>>>>()

  /** Lazily sorted distinct keys for range queries; writes invalidate a field's cache. */
  #sortedIndexKeys = new Map<string, Map<string, SortedIndexKey[]>>()

  /**
   * Records that could not be indexed (a boolean, `null`, object or array in an
   * indexed field is not a valid IndexedDB key). While a collection/field has
   * any of these, `scanIndex` falls back to a full scan so results stay correct.
   */
  #unindexable = new Map<string, Map<string, number>>()

  async connect(_name: string, schema: SchemaConfig | null): Promise<void> {
    this.#connected = true
    this.#uniqueIndexes.clear()
    this.#indexes.clear()
    this.#sortedIndexKeys.clear()
    this.#unindexable.clear()

    if (schema?.collections) {
      for (const [name, collectionSchema] of Object.entries(schema.collections)) {
        if (!this.#data.has(name)) {
          this.#data.set(name, new Map())
        }
        const unique = (collectionSchema.indexes ?? [])
          .filter((index) => index.unique)
          .map((index) => index.field)
        if (unique.length > 0) this.#uniqueIndexes.set(name, unique)

        const fields = (collectionSchema.indexes ?? []).map((index) => index.field)
        if (fields.length > 0) {
          this.#indexes.set(
            name,
            new Map(fields.map((field) => [field, new Map<string, Set<ID>>()])),
          )
          // Reconnecting to a store that still holds rows must not leave the
          // index empty, so rebuild it from what is already there.
          for (const [id, record] of this.#data.get(name) ?? []) {
            this.#applyIndexes(name, id, undefined, record)
          }
        }
      }

      // Plugin stores (e.g. the full-text posting store) are declared the same
      // way, so an indexed lookup on one behaves like a collection lookup
      // instead of silently scanning (IndexedDB already creates these indexes).
      for (const entry of schema.pluginStoreNames ?? []) {
        const storeName = typeof entry === "string" ? entry : entry.name
        if (!this.#data.has(storeName)) this.#data.set(storeName, new Map())

        const fields = (typeof entry === "string" ? [] : (entry.indexes ?? [])).map(
          (index) => index.field,
        )
        if (fields.length > 0) {
          this.#indexes.set(
            storeName,
            new Map(fields.map((field) => [field, new Map<string, Set<ID>>()])),
          )
        }
      }
    }
  }

  hasIndex(collection: string, indexName: string): boolean {
    return this.#indexes.get(collection)?.has(indexName) ?? false
  }

  async disconnect(): Promise<void> {
    this.#data.clear()

    this.#meta.clear()
    this.#uniqueIndexes.clear()
    this.#indexes.clear()
    this.#sortedIndexKeys.clear()
    this.#unindexable.clear()
    this.#connected = false
  }

  /**
   * Keep the index structures in step with a write.
   *
   * Called for every mutation, including the journal replay used to roll a
   * transaction back, so the two can never disagree.
   */
  #applyIndexes(
    collection: string,
    id: ID,
    previous: Record<string, unknown> | undefined,
    next: Record<string, unknown> | undefined,
  ): void {
    const fields = this.#indexes.get(collection)
    if (!fields) return

    for (const [field, buckets] of fields) {
      const before = previous?.[field]
      const after = next?.[field]

      if (before !== undefined && before !== after) {
        const key = encodeIndexKey(before)
        if (key === null) {
          this.#adjustUnindexable(collection, field, -1)
        } else {
          const bucket = buckets.get(key)
          bucket?.delete(id)
          if (bucket?.size === 0) {
            buckets.delete(key)
            this.#invalidateSortedIndexKeys(collection, field)
          }
        }
      }

      if (after !== undefined && after !== before) {
        const key = encodeIndexKey(after)
        if (key === null) {
          this.#adjustUnindexable(collection, field, 1)
        } else {
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = new Set()
            buckets.set(key, bucket)
            this.#invalidateSortedIndexKeys(collection, field)
          }
          bucket.add(id)
        }
      }
    }
  }

  #invalidateSortedIndexKeys(collection: string, field: string): void {
    const cached = this.#sortedIndexKeys.get(collection)
    cached?.delete(field)
    if (cached?.size === 0) this.#sortedIndexKeys.delete(collection)
  }

  #getSortedIndexKeys(
    collection: string,
    field: string,
    buckets: Map<string, Set<ID>>,
  ): SortedIndexKey[] {
    let fields = this.#sortedIndexKeys.get(collection)
    if (!fields) {
      fields = new Map()
      this.#sortedIndexKeys.set(collection, fields)
    }

    let sorted = fields.get(field)
    if (!sorted) {
      sorted = [...buckets.keys()]
        .map((encoded) => ({ encoded, value: decodeIndexKey(encoded) }))
        .sort((a, b) => compareQueryKeys(a.value, b.value))
      fields.set(field, sorted)
    }
    return sorted
  }

  #lowerBound(keys: SortedIndexKey[], value: QueryKey, open: boolean): number {
    let low = 0
    let high = keys.length
    while (low < high) {
      const mid = low + ((high - low) >> 1)
      const compared = compareQueryKeys(keys[mid]!.value, value)
      if (compared < 0 || (open && compared === 0)) low = mid + 1
      else high = mid
    }
    return low
  }

  #upperBound(keys: SortedIndexKey[], value: QueryKey, open: boolean): number {
    let low = 0
    let high = keys.length
    while (low < high) {
      const mid = low + ((high - low) >> 1)
      const compared = compareQueryKeys(keys[mid]!.value, value)
      if (compared < 0 || (!open && compared === 0)) low = mid + 1
      else high = mid
    }
    return low
  }

  #adjustUnindexable(collection: string, field: string, delta: number): void {
    let collectionMap = this.#unindexable.get(collection)
    if (!collectionMap) {
      collectionMap = new Map()
      this.#unindexable.set(collection, collectionMap)
    }
    const next = Math.max(0, (collectionMap.get(field) ?? 0) + delta)
    if (next === 0) collectionMap.delete(field)
    else collectionMap.set(field, next)
  }

  /**
   * Reject a write that would violate a declared unique index.
   *
   * IndexedDB enforces this natively; without the same check the memory
   * adapter silently accepted duplicates, so code that passed in Node failed
   * in the browser (audit H-06).
   */
  #assertUnique(collection: string, candidate: Record<string, unknown>, ignoreId?: ID): void {
    const uniqueFields = this.#uniqueIndexes.get(collection)
    if (!uniqueFields || uniqueFields.length === 0) return

    const store = this.#data.get(collection)
    if (!store) return

    for (const field of uniqueFields) {
      const value = candidate[field]
      if (value === undefined || value === null) continue

      for (const [id, record] of store) {
        if (ignoreId !== undefined && String(id) === String(ignoreId)) continue
        if (record[field] === value) {
          throw new Error(
            `Unique constraint failed on "${collection}.${field}": value ${JSON.stringify(value)} already exists`,
          )
        }
      }
    }
  }

  isConnected(): boolean {
    return this.#connected
  }

  async create(collection: string, data: unknown): Promise<Record<string, unknown>> {
    this.#ensureCollection(collection)
    const store = this.#data.get(collection)
    if (!store) throw new Error(`Collection "${collection}" not initialized`)

    const input = data as Record<string, unknown>
    const id = input.id as ID
    if (id === undefined) {
      throw new Error(
        "id is required. Use collection.create({ id: '...', ... }) or let the Collection layer generate one.",
      )
    }

    if (store.has(id)) {
      // IndexedDB's `add()` rejects with ConstraintError here; overwriting
      // would silently destroy the existing record (audit H-06).
      throw new Error(`Record "${id}" already exists in "${collection}"`)
    }

    const record = { id, ...input }
    this.#assertUnique(collection, record)
    store.set(id, record)
    this.#applyIndexes(collection, id, undefined, record)
    return { ...record }
  }

  /**
   * Insert a batch atomically.
   *
   * Every check runs before the first write, and nothing in between awaits, so
   * a rejected batch leaves the collection exactly as it was. The unique-index
   * check builds one value set per field instead of re-scanning the store per
   * record, which is what a per-record loop costs.
   */
  async createMany(collection: string, records: unknown[]): Promise<Record<string, unknown>[]> {
    this.#ensureCollection(collection)
    const store = this.#data.get(collection)
    if (!store) throw new Error(`Collection "${collection}" not initialized`)

    const prepared: Record<string, unknown>[] = []
    const ids = new Set<ID>()

    for (const data of records) {
      const input = data as Record<string, unknown>
      const id = input.id as ID
      if (id === undefined) {
        throw new Error(
          "id is required. Use collection.create({ id: '...', ... }) or let the Collection layer generate one.",
        )
      }
      // Includes duplicates *within* the batch: IndexedDB rejects those too.
      if (store.has(id) || ids.has(id)) {
        throw new Error(`Record "${id}" already exists in "${collection}"`)
      }
      ids.add(id)
      prepared.push({ id, ...input })
    }

    const uniqueFields = this.#uniqueIndexes.get(collection)
    if (uniqueFields && uniqueFields.length > 0) {
      for (const field of uniqueFields) {
        const taken = new Set<unknown>()
        for (const record of store.values()) {
          const value = record[field]
          if (value !== undefined && value !== null) taken.add(value)
        }
        for (const record of prepared) {
          const value = record[field]
          if (value === undefined || value === null) continue
          if (taken.has(value)) {
            throw new Error(
              `Unique constraint failed on "${collection}.${field}": value ${JSON.stringify(value)} already exists`,
            )
          }
          taken.add(value)
        }
      }
    }

    for (const record of prepared) {
      const id = record.id as ID
      store.set(id, record)
      this.#applyIndexes(collection, id, undefined, record)
    }

    return prepared.map((record) => ({ ...record }))
  }

  async findById(collection: string, id: ID): Promise<Record<string, unknown> | undefined> {
    const store = this.#data.get(collection)
    if (!store) return undefined
    const record = store.get(id)
    return record ? { ...record } : undefined
  }

  async findByIds(collection: string, ids: ID[]): Promise<(Record<string, unknown> | undefined)[]> {
    const store = this.#data.get(collection)
    if (!store) return ids.map(() => undefined)
    return ids.map((id) => {
      const record = store.get(id)
      return record ? { ...record } : undefined
    })
  }

  async findAll(collection: string): Promise<Record<string, unknown>[]> {
    const store = this.#data.get(collection)
    if (!store) return []
    return [...store.values()].map((r) => ({ ...r }))
  }

  /** O(1): the rows are already in a Map, so counting must not copy them. */
  async count(collection: string): Promise<number> {
    return this.#data.get(collection)?.size ?? 0
  }

  async update(
    collection: string,
    id: ID,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const store = this.#data.get(collection)
    if (!store) throw new Error(`Collection "${collection}" not found`)
    const record = store.get(id)
    if (!record) throw new Error(`Record "${id}" not found in "${collection}"`)
    const updated = { ...record, ...changes }
    this.#assertUnique(collection, updated, id)
    store.set(id, updated)
    this.#applyIndexes(collection, id, record, updated)
    return { ...updated }
  }

  async delete(collection: string, id: ID): Promise<void> {
    const store = this.#data.get(collection)
    const existing = store?.get(id)
    store?.delete(id)
    if (existing) this.#applyIndexes(collection, id, existing, undefined)
  }

  async deleteMany(collection: string, ids: ID[]): Promise<void> {
    const store = this.#data.get(collection)
    if (!store) return
    for (const id of ids) {
      const existing = store.get(id)
      store.delete(id)
      if (existing) this.#applyIndexes(collection, id, existing, undefined)
    }
  }

  async scanIndex(
    collection: string,
    indexName: string,
    range: QueryRange | undefined,
    postFilters: QueryCondition[],
  ): Promise<Record<string, unknown>[]> {
    const buckets = this.#indexes.get(collection)?.get(indexName)
    const skipped = this.#unindexable.get(collection)?.get(indexName) ?? 0

    // No index (unconfigured field) or rows whose value is not a valid key:
    // fall back to a scan so the result set is always complete.
    if (!buckets || skipped > 0) {
      return this.#scanWithFilters(collection, indexName, range, postFilters)
    }

    const store = this.#data.get(collection)
    if (!store) return []

    const ids = new Set<ID>()

    if (!range) {
      for (const bucket of buckets.values()) {
        for (const id of bucket) ids.add(id)
      }
    } else if (
      range.lower !== undefined &&
      range.upper !== undefined &&
      !range.lowerOpen &&
      !range.upperOpen &&
      range.lower === range.upper
    ) {
      // The common case: equality. One bucket lookup, no full scan.
      const exact = buckets.get(encodeIndexKey(range.lower) ?? "")
      if (exact) for (const id of exact) ids.add(id)
    } else {
      // Walk only the matching key span. The previous Map traversal compared
      // every distinct key for every range query (20k keys made a one-row range
      // slower than a scan). Cache sorted distinct keys and binary-search bounds;
      // writes invalidate this small cache only when a key bucket appears/disappears.
      const sorted = this.#getSortedIndexKeys(collection, indexName, buckets)
      const start =
        range.lower === undefined ? 0 : this.#lowerBound(sorted, range.lower, range.lowerOpen)
      const end =
        range.upper === undefined
          ? sorted.length
          : this.#upperBound(sorted, range.upper, range.upperOpen)
      let candidateCount = 0
      for (let i = start; i < end; i++) {
        const bucket = buckets.get(sorted[i]!.encoded)
        if (!bucket) continue
        candidateCount += bucket.size
        for (const id of bucket) ids.add(id)
      }

      // For broad ranges, random Map lookups and Set construction cost more
      // than a sequential scan. This is only safe when the range is the whole
      // filter set; post-filters may make a broad index range selective again.
      if (postFilters.length === 0 && candidateCount >= store.size * 0.4) {
        return this.#scanWithFilters(collection, indexName, range, postFilters)
      }
    }

    const results: Record<string, unknown>[] = []
    for (const id of ids) {
      const record = store.get(id)
      if (!record) continue
      // Defensive: the bucket is authoritative for membership, but a record is
      // only returned when it still matches (guards against a stale entry).
      if (range && !queryRangeContains(range, record[indexName])) continue
      results.push({ ...record })
    }

    return this.#applyPostFilters(results, postFilters)
  }

  #applyPostFilters(
    records: Record<string, unknown>[],
    postFilters: QueryCondition[],
  ): Record<string, unknown>[] {
    let results = records
    for (const cond of postFilters) {
      // `search` is applied by the executor after the adapter returns.
      if (cond.type === "search") continue
      results = results.filter((r) => matchesWhere(r, cond))
    }
    return results
  }

  #scanWithFilters(
    collection: string,
    indexName: string,
    range: QueryRange | undefined,
    postFilters: QueryCondition[],
  ): Record<string, unknown>[] {
    const store = this.#data.get(collection)
    if (!store) return []
    let results = [...store.values()].map((record) => ({ ...record }))
    if (range) {
      results = results.filter((record) => queryRangeContains(range, record[indexName]))
    }
    return this.#applyPostFilters(results, postFilters)
  }

  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    // Journal per operation instead of snapshotting the whole store: a
    // snapshot-based rollback also undid *unrelated* writes that happened
    // concurrently while the transaction was in flight (audit H-05).
    const context = new MemoryTransactionContext(this)
    try {
      return await fn(context)
    } catch (error) {
      context.rollback()
      throw error
    }
  }

  /** @internal used by the transaction journal */
  _record(collection: string, id: ID): Record<string, unknown> | undefined {
    const record = this.#data.get(collection)?.get(id)
    return record ? { ...record } : undefined
  }

  /** @internal used by the transaction journal */
  _write(collection: string, id: ID, record: Record<string, unknown> | undefined): void {
    const store = this.#data.get(collection)
    if (!store) return
    const previous = store.get(id)
    if (record === undefined) store.delete(id)
    else store.set(id, record)
    this.#applyIndexes(collection, id, previous, record)
  }

  async getMetadata(key: string): Promise<unknown> {
    return this.#meta.get(key)
  }

  async setMetadata(key: string, value: unknown): Promise<void> {
    this.#meta.set(key, value)
  }

  async getSchemaVersion(): Promise<number> {
    return (this.#meta.get("schemaVersion") as number) || 0
  }

  async setSchemaVersion(version: number): Promise<void> {
    this.#meta.set("schemaVersion", version)
  }

  #ensureCollection(name: string): void {
    if (!this.#data.has(name)) {
      this.#data.set(name, new Map())
    }
  }
}

/**
 * Scoped handle over the memory store with an undo journal.
 *
 * Mirrors `IDBTransactionContext`: operations run against one collection, and a
 * thrown error reverts only the writes this transaction made, in reverse order.
 */
class MemoryTransactionContext implements TransactionContext {
  #adapter: MemoryAdapter
  #undo: Array<() => void> = []

  constructor(adapter: MemoryAdapter) {
    this.#adapter = adapter
  }

  collection(name: string): TransactionCollection {
    const adapter = this.#adapter
    const undo = this.#undo

    return {
      async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const created = await adapter.create(name, data)
        const id = created.id as ID
        undo.push(() => adapter._write(name, id, undefined))
        return created
      },

      async findById(id: ID) {
        return adapter.findById(name, id)
      },

      async findAll() {
        return adapter.findAll(name)
      },

      async update(id: ID, changes: Record<string, unknown>) {
        const before = adapter._record(name, id)
        const updated = await adapter.update(name, id, changes)
        undo.push(() => adapter._write(name, id, before))
        return updated
      },

      async delete(id: ID) {
        const before = adapter._record(name, id)
        await adapter.delete(name, id)
        undo.push(() => adapter._write(name, id, before))
      },
    }
  }

  /** Revert this transaction's writes, newest first. */
  rollback(): void {
    for (let i = this.#undo.length - 1; i >= 0; i--) {
      try {
        this.#undo[i]?.()
      } catch {
        // A failed undo must not mask the original error.
      }
    }
    this.#undo = []
  }
}
