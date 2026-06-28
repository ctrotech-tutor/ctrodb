import type { ID, QueryCondition, SchemaConfig, StorageAdapter, TransactionContext } from "../types"

function openDB(
  dbName: string,
  version: number,
  onUpgrade: (db: IDBDatabase, oldVersion: number) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, version)

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      onUpgrade(request.result, event.oldVersion)
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      console.warn(`[ctrodb] Database "${dbName}" blocked. Close other tabs using this database.`)
    }
  })
}

function createMigrationHandler(schema: SchemaConfig | null) {
  return function onUpgrade(db: IDBDatabase, _oldVersion: number): void {
    if (!schema) return

    for (const [collectionName, collectionSchema] of Object.entries(schema.collections)) {
      if (!db.objectStoreNames.contains(collectionName)) {
        const store = db.createObjectStore(collectionName, {
          keyPath: "id",
        })

        if (collectionSchema.indexes) {
          for (const indexDef of collectionSchema.indexes) {
            store.createIndex(indexDef.field, indexDef.field, {
              unique: indexDef.unique || false,
            })
          }
        }
      }
    }

    if (schema.pluginStoreNames) {
      for (const storeName of schema.pluginStoreNames) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "id" })
        }
      }
    }

    if (!db.objectStoreNames.contains("_ctrodb_meta")) {
      db.createObjectStore("_ctrodb_meta", { keyPath: "id" })
    }
  }
}

function idbCreate(
  db: IDBDatabase,
  collection: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, "readwrite")
    const store = tx.objectStore(collection)
    const request = store.add(data)

    request.onsuccess = () => resolve({ id: request.result, ...data })
    request.onerror = () => reject(request.error)
  })
}

function idbFindById(
  db: IDBDatabase,
  collection: string,
  id: ID,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, "readonly")
    const store = tx.objectStore(collection)
    const request = store.get(id)

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idbFindAll(db: IDBDatabase, collection: string): Promise<Record<string, unknown>[]> {
  if (!db.objectStoreNames.contains(collection)) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, "readonly")
    const store = tx.objectStore(collection)
    const request = store.getAll()

    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

function idbUpdate(
  db: IDBDatabase,
  collection: string,
  id: ID,
  changes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, "readwrite")
    const store = tx.objectStore(collection)

    const getRequest = store.get(id)
    getRequest.onsuccess = () => {
      const existing = getRequest.result
      if (!existing) {
        reject(new Error(`Record "${id}" not found in "${collection}"`))
        return
      }
      const updated = { ...existing, ...changes }
      const putRequest = store.put(updated)
      putRequest.onsuccess = () => resolve(updated)
      putRequest.onerror = () => reject(putRequest.error)
    }
    getRequest.onerror = () => reject(getRequest.error)
  })
}

function idbDelete(db: IDBDatabase, collection: string, id: ID): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, "readwrite")
    const store = tx.objectStore(collection)
    const request = store.delete(id)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function idbScanIndex(
  db: IDBDatabase,
  collection: string,
  indexName: string,
  range: IDBKeyRange | undefined,
  postFilters: QueryCondition[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, "readonly")
    const store = tx.objectStore(collection)
    const index = store.index(indexName)
    const request = range ? index.getAll(range) : index.getAll()

    request.onsuccess = () => {
      let results = request.result || []

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

      resolve(results)
    }

    request.onerror = () => reject(request.error)
  })
}

export class IndexedDBAdapter implements StorageAdapter {
  readonly name = "indexeddb"

  #db: IDBDatabase | null = null
  #connected = false

  async connect(name: string, schema: SchemaConfig | null): Promise<void> {
    const version = schema?.version || 1
    const migrationHandler = createMigrationHandler(schema)
    this.#db = await openDB(name, version, migrationHandler)
    this.#connected = true
  }

  async disconnect(): Promise<void> {
    this.#db?.close()
    this.#db = null
    this.#connected = false
  }

  isConnected(): boolean {
    return this.#connected
  }

  #getDb(): IDBDatabase {
    if (!this.#connected || !this.#db) {
      throw new Error("Database is not connected. Call database.connect() first.")
    }
    return this.#db
  }

  async create(collection: string, data: unknown): Promise<Record<string, unknown>> {
    return idbCreate(this.#getDb(), collection, data as Record<string, unknown>)
  }

  async findById(collection: string, id: ID): Promise<Record<string, unknown> | undefined> {
    return idbFindById(this.#getDb(), collection, id)
  }

  async findAll(collection: string): Promise<Record<string, unknown>[]> {
    return idbFindAll(this.#getDb(), collection)
  }

  async update(
    collection: string,
    id: ID,
    changes: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return idbUpdate(this.#getDb(), collection, id, changes)
  }

  async delete(collection: string, id: ID): Promise<void> {
    return idbDelete(this.#getDb(), collection, id)
  }

  async deleteMany(collection: string, ids: ID[]): Promise<void> {
    const db = this.#getDb()
    const tx = db.transaction(collection, "readwrite")
    const store = tx.objectStore(collection)
    for (const id of ids) {
      store.delete(id)
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async scanIndex(
    collection: string,
    indexName: string,
    range: IDBKeyRange | undefined,
    postFilters: QueryCondition[],
  ): Promise<Record<string, unknown>[]> {
    return idbScanIndex(this.#getDb(), collection, indexName, range, postFilters)
  }

  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const db = this.#getDb()
    const storeNames = [...db.objectStoreNames]
    const tx = db.transaction(storeNames, "readwrite")

    try {
      const ctx = new IDBTransactionContext(db, tx)
      const result = await fn(ctx)
      return result
    } catch (error) {
      tx.abort()
      throw error
    }
  }

  async getMetadata(key: string): Promise<unknown> {
    const db = this.#getDb()
    const meta = await idbFindById(db, "_ctrodb_meta", key as ID)
    return meta?.value
  }

  async setMetadata(key: string, value: unknown): Promise<void> {
    const db = this.#getDb()
    if (!db.objectStoreNames.contains("_ctrodb_meta")) return
    const existing = await idbFindById(db, "_ctrodb_meta", key as ID)
    if (existing) {
      await idbUpdate(
        db,
        "_ctrodb_meta",
        key as ID,
        {
          value,
        } as Record<string, unknown>,
      )
    } else {
      await idbCreate(db, "_ctrodb_meta", {
        id: key,
        key,
        value,
      } as unknown as Record<string, unknown>)
    }
  }

  async getSchemaVersion(): Promise<number> {
    return ((await this.getMetadata("schemaVersion")) as number) || 0
  }

  async setSchemaVersion(version: number): Promise<void> {
    await this.setMetadata("schemaVersion", version)
  }
}

class IDBTransactionContext implements TransactionContext {
  #db: IDBDatabase
  #tx: IDBTransaction

  constructor(db: IDBDatabase, tx: IDBTransaction) {
    this.#db = db
    this.#tx = tx
  }

  collection(name: string): {
    create(data: Record<string, unknown>): Promise<Record<string, unknown>>
    findById(id: ID): Promise<Record<string, unknown> | undefined>
    findAll(): Promise<Record<string, unknown>[]>
    update(id: ID, changes: Record<string, unknown>): Promise<Record<string, unknown>>
    delete(id: ID): Promise<void>
  } {
    return createTransactionCollection(name, this.#db, this.#tx)
  }
}

function createTransactionCollection(collection: string, _db: IDBDatabase, tx: IDBTransaction) {
  return {
    create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const store = tx.objectStore(collection)
        const request = store.add(data)
        request.onsuccess = () => resolve({ id: request.result, ...data })
        request.onerror = () => reject(request.error)
      })
    },
    findById(id: ID): Promise<Record<string, unknown> | undefined> {
      return new Promise((resolve, reject) => {
        const store = tx.objectStore(collection)
        const request = store.get(id)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    },
    findAll(): Promise<Record<string, unknown>[]> {
      return new Promise((resolve, reject) => {
        const store = tx.objectStore(collection)
        const request = store.getAll()
        request.onsuccess = () => resolve(request.result || [])
        request.onerror = () => reject(request.error)
      })
    },
    update(id: ID, changes: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const store = tx.objectStore(collection)
        const getRequest = store.get(id)
        getRequest.onsuccess = () => {
          const existing = getRequest.result
          if (!existing) {
            reject(new Error(`Record "${id}" not found in "${collection}"`))
            return
          }
          const updated = { ...existing, ...changes }
          const putRequest = store.put(updated)
          putRequest.onsuccess = () => resolve(updated)
          putRequest.onerror = () => reject(putRequest.error)
        }
        getRequest.onerror = () => reject(getRequest.error)
      })
    },
    delete(id: ID): Promise<void> {
      return new Promise((resolve, reject) => {
        const store = tx.objectStore(collection)
        const request = store.delete(id)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    },
  }
}
