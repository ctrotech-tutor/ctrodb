import type { ID, QueryCondition, StorageAdapter, TransactionContext } from "../types"

export class MemoryAdapter implements StorageAdapter {
  readonly name = "memory"

  #data = new Map<string, Map<ID, Record<string, unknown>>>()
  #counters = new Map<string, number>()
  #meta = new Map<string, unknown>()
  #connected = false

  async connect(
    _name: string,
    schema: { collections: Record<string, unknown> } | null,
  ): Promise<void> {
    this.#connected = true
    if (schema?.collections) {
      for (const name of Object.keys(schema.collections)) {
        if (!this.#data.has(name)) {
          this.#data.set(name, new Map())
          this.#counters.set(name, 1)
        }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.#data.clear()
    this.#counters.clear()
    this.#meta.clear()
    this.#connected = false
  }

  isConnected(): boolean {
    return this.#connected
  }

  async create(collection: string, data: unknown): Promise<Record<string, unknown>> {
    this.#ensureCollection(collection)
    const store = this.#data.get(collection)
    const id = this.#counters.get(collection)
    if (!store || id === undefined) throw new Error(`Collection "${collection}" not initialized`)
    this.#counters.set(collection, id + 1)
    const record = { id, ...(data as Record<string, unknown>) }
    store.set(id as ID, record)
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
    range: IDBKeyRange | undefined,
    postFilters: QueryCondition[],
  ): Promise<Record<string, unknown>[]> {
    const all = await this.findAll(collection)
    let results = all

    if (range) {
      results = results.filter((r) => {
        const val = r[indexName] as unknown
        if (range.lower !== undefined) {
          if (
            range.lowerOpen
              ? (val as number) <= (range.lower as number)
              : (val as number) < (range.lower as number)
          )
            return false
        }
        if (range.upper !== undefined) {
          if (
            range.upperOpen
              ? (val as number) >= (range.upper as number)
              : (val as number) > (range.upper as number)
          )
            return false
        }
        return true
      })
    }

    for (const cond of postFilters) {
      if (cond.type === "search") continue
      results = results.filter((r) => {
        const val = r[cond.field] as unknown
        switch (cond.op) {
          case "==":
            return val === cond.value
          case "!=":
            return val !== cond.value
          case ">":
            return (val as number) > (cond.value as number)
          case ">=":
            return (val as number) >= (cond.value as number)
          case "<":
            return (val as number) < (cond.value as number)
          case "<=":
            return (val as number) <= (cond.value as number)
          default:
            return true
        }
      })
    }

    return results
  }

  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const snapshot = this.#snapshot()
    try {
      return await fn(new MemoryTransactionContext(this))
    } catch (error) {
      this.#restore(snapshot)
      throw error
    }
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
      this.#counters.set(name, 1)
    }
  }

  #snapshot(): {
    data: Map<string, Map<ID, Record<string, unknown>>>
    counters: Map<string, number>
  } {
    return {
      data: new Map([...this.#data].map(([k, v]) => [k, new Map(v)])),
      counters: new Map(this.#counters),
    }
  }

  #restore(snapshot: {
    data: Map<string, Map<ID, Record<string, unknown>>>
    counters: Map<string, number>
  }): void {
    this.#data = snapshot.data
    this.#counters = snapshot.counters
  }
}

class MemoryTransactionContext implements TransactionContext {
  #adapter: MemoryAdapter

  constructor(adapter: MemoryAdapter) {
    this.#adapter = adapter
  }

  collection(_name: string): unknown {
    return this.#adapter
  }
}
