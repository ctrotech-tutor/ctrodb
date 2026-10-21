import { matchesWhere } from "../query/predicate"
import { queryRangeContains } from "../query/range"
import type {
  ID,
  QueryCondition,
  QueryRange,
  SchemaConfig,
  StorageAdapter,
  TransactionCollection,
  TransactionContext,
} from "../types"

export class MemoryAdapter implements StorageAdapter {
  readonly name = "memory"

  #data = new Map<string, Map<ID, Record<string, unknown>>>()

  #meta = new Map<string, unknown>()
  #connected = false
  /** Unique index fields per collection, mirroring what IndexedDB enforces. */
  #uniqueIndexes = new Map<string, string[]>()

  async connect(_name: string, schema: SchemaConfig | null): Promise<void> {
    this.#connected = true
    this.#uniqueIndexes.clear()

    if (schema?.collections) {
      for (const [name, collectionSchema] of Object.entries(schema.collections)) {
        if (!this.#data.has(name)) {
          this.#data.set(name, new Map())
        }
        const unique = (collectionSchema.indexes ?? [])
          .filter((index) => index.unique)
          .map((index) => index.field)
        if (unique.length > 0) this.#uniqueIndexes.set(name, unique)
      }
    }
  }

  async disconnect(): Promise<void> {
    this.#data.clear()

    this.#meta.clear()
    this.#uniqueIndexes.clear()
    this.#connected = false
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
    return { ...record }
  }

  async findById(collection: string, id: ID): Promise<Record<string, unknown> | undefined> {
    const store = this.#data.get(collection)
    if (!store) return undefined
    const record = store.get(id)
    return record ? { ...record } : undefined
  }

  async findAll(collection: string): Promise<Record<string, unknown>[]> {
    const store = this.#data.get(collection)
    if (!store) return []
    return [...store.values()].map((r) => ({ ...r }))
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
    return { ...updated }
  }

  async delete(collection: string, id: ID): Promise<void> {
    this.#data.get(collection)?.delete(id)
  }

  async deleteMany(collection: string, ids: ID[]): Promise<void> {
    const store = this.#data.get(collection)
    if (!store) return
    for (const id of ids) store.delete(id)
  }

  async scanIndex(
    collection: string,
    indexName: string,
    range: QueryRange | undefined,
    postFilters: QueryCondition[],
  ): Promise<Record<string, unknown>[]> {
    const all = await this.findAll(collection)
    let results = all

    if (range) {
      results = results.filter((record) => queryRangeContains(range, record[indexName]))
    }

    for (const cond of postFilters) {
      // `search` is applied by the executor after the adapter returns.
      if (cond.type === "search") continue
      results = results.filter((r) => matchesWhere(r, cond))
    }

    return results
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
    if (record === undefined) store.delete(id)
    else store.set(id, record)
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
