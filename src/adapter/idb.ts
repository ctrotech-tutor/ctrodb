import type {
  ID,
  PluginStoreConfig,
  QueryCondition,
  QueryRange,
  SchemaConfig,
  StorageAdapter,
  TransactionCollection,
  TransactionContext,
} from "../types"

/**
 * Translate a storage-neutral range into a real `IDBKeyRange`.
 *
 * This is the only place in the codebase that touches `IDBKeyRange`, and it is
 * reached exclusively from the IndexedDB adapter.
 */
function toIDBKeyRange(range: QueryRange | undefined): IDBKeyRange | undefined {
  if (!range) return undefined

  const { lower, upper, lowerOpen, upperOpen } = range

  if (lower !== undefined && upper !== undefined) {
    if (!lowerOpen && !upperOpen) {
      return IDBKeyRange.only(lower as IDBValidKey)
    }
    return IDBKeyRange.bound(lower as IDBValidKey, upper as IDBValidKey, lowerOpen, upperOpen)
  }

  if (lower !== undefined) {
    return IDBKeyRange.lowerBound(lower as IDBValidKey, lowerOpen)
  }

  if (upper !== undefined) {
    return IDBKeyRange.upperBound(upper as IDBValidKey, upperOpen)
  }

  return undefined
}

function openDB(
  dbName: string,
  version: number,
  onUpgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, version)

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      // `request.transaction` is the versionchange transaction, and it is the
      // only handle that can modify existing stores (e.g. add an index).
      const tx = request.transaction
      if (!tx) {
        throw new Error(`[ctrodb] Upgrade of "${dbName}" ran without a versionchange transaction`)
      }
      onUpgrade(request.result, event.oldVersion, tx)
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      // Do not leave the caller hanging: a blocked upgrade cannot complete
      // until every other connection to this database is closed, so report it
      // with an actionable message instead of waiting forever.
      reject(
        new Error(
          `[ctrodb] Opening "${dbName}" is blocked by another connection (usually another tab). ` +
            "Close other tabs running this app, then retry.",
        ),
      )
    }
  })
}

function createMigrationHandler(schema: SchemaConfig | null) {
  return function onUpgrade(db: IDBDatabase, _oldVersion: number, tx: IDBTransaction): void {
    if (!schema) return

    const syncIndexes = (
      store: IDBObjectStore,
      definitions: readonly { field: string; unique?: boolean }[] | undefined,
    ): void => {
      for (const indexDef of definitions ?? []) {
        const desiredUnique = indexDef.unique ?? false
        const existing = store.indexNames.contains(indexDef.field)
          ? store.index(indexDef.field)
          : null

        if (existing) {
          // A unique flag change requires a rebuild; the data itself is kept.
          if (existing.unique === desiredUnique) continue
          store.deleteIndex(indexDef.field)
        }

        try {
          store.createIndex(indexDef.field, indexDef.field, { unique: desiredUnique })
        } catch (error) {
          // e.g. an existing index with the same name on a different keyPath
          console.warn(
            `[ctrodb] Could not create index "${indexDef.field}" on "${store.name}":`,
            error,
          )
        }
      }
    }

    for (const [collectionName, collectionSchema] of Object.entries(schema.collections)) {
      if (!db.objectStoreNames.contains(collectionName)) {
        const store = db.createObjectStore(collectionName, {
          keyPath: "id",
        })
        syncIndexes(store, collectionSchema.indexes)
        continue
      }

      // The store already exists: reconcile indexes so schema additions take
      // effect on the next upgrade instead of being silently ignored.
      syncIndexes(tx.objectStore(collectionName), collectionSchema.indexes)
    }

    if (schema.pluginStoreNames) {
      for (const entry of schema.pluginStoreNames) {
        const storeName = typeof entry === "string" ? entry : entry.name
        const config = typeof entry === "string" ? null : (entry as PluginStoreConfig)

        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: "id" })
          syncIndexes(store, config?.indexes)
        } else if (config?.indexes) {
          syncIndexes(tx.objectStore(storeName), config.indexes)
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
  range: QueryRange | undefined,
  postFilters: QueryCondition[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, "readonly")
    const store = tx.objectStore(collection)
    const index = store.index(indexName)
    const keyRange = toIDBKeyRange(range)
    const request = keyRange ? index.getAll(keyRange) : index.getAll()

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
    range: QueryRange | undefined,
    postFilters: QueryCondition[],
  ): Promise<Record<string, unknown>[]> {
    return idbScanIndex(this.#getDb(), collection, indexName, range, postFilters)
  }

  /**
   * Run `fn` inside one IndexedDB transaction.
   *
   * Guarantees, now actually enforced (audit H-03):
   *  - resolves only after the transaction has **committed** (`tx.oncomplete`);
   *  - if `fn` throws, the transaction is aborted, no write is applied, and the
   *    caller's original error propagates unchanged — previously `tx.abort()`
   *    could itself throw `InvalidStateError`, masking the real cause;
   *  - awaiting non-database async work (timers, network) inside `fn` lets the
   *    transaction auto-commit, which used to surface as a confusing
   *    `InvalidStateError` from deep inside the adapter.
   */
  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const db = this.#getDb()
    const storeNames = [...db.objectStoreNames]
    const tx = db.transaction(storeNames, "readwrite")

    // Attach handlers before the first await: a fast transaction can complete
    // while the callback is still running.
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(transactionError(tx.error))
      tx.onerror = () => {
        /* surfaced through onabort; keep the event from going unhandled */
      }
    })
    // The completion promise is only awaited on the success path, so mark the
    // rejection as handled up front to avoid unhandledRejection noise.
    completed.catch(() => {})

    const ctx = new IDBTransactionContext(db, tx)

    let result: T
    try {
      result = await fn(ctx)
    } catch (error) {
      try {
        tx.abort()
      } catch {
        // Already committed or aborted — the caller's error is the truth.
      }
      throw error
    }

    // The callback resolved, so only a successful commit may resolve the
    // caller. A rejected `completed` (abort/error) propagates as-is.
    await completed

    return result
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

/** Turn an abort reason into an actionable message. */
function transactionError(error: DOMException | null): Error {
  if (!error) return new Error("[ctrodb] Transaction was aborted")
  return new Error(`[ctrodb] Transaction aborted: ${error.name} — ${error.message}`, {
    cause: error,
  })
}

/**
 * Normalise the most common IDB trap: the transaction auto-committed because
 * the callback awaited something that is not a database request.
 */
function normalizeRequestError(error: DOMException | null): Error {
  if (error?.name === "TransactionInactiveError") {
    return new Error(
      "[ctrodb] The transaction is no longer active. Do not await timers, fetch or other " +
        "non-database work inside db.transaction(); IndexedDB commits as soon as the " +
        "transaction goes idle.",
      { cause: error },
    )
  }
  return error
    ? new Error(error.message, { cause: error })
    : new Error("[ctrodb] Unknown IndexedDB error")
}

class IDBTransactionContext implements TransactionContext {
  #db: IDBDatabase
  #tx: IDBTransaction

  constructor(db: IDBDatabase, tx: IDBTransaction) {
    this.#db = db
    this.#tx = tx
  }

  collection(name: string): TransactionCollection {
    return createTransactionCollection(name, this.#db, this.#tx)
  }
}

function createTransactionCollection(
  collection: string,
  _db: IDBDatabase,
  tx: IDBTransaction,
): TransactionCollection {
  /** Run an operation, converting sync IDB throws into a rejected promise. */
  const guard = <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return operation()
    } catch (error) {
      return Promise.reject(normalizeRequestError(error as DOMException | null))
    }
  }

  return {
    create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
      return guard(
        () =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(collection).add(data)
            request.onsuccess = () => resolve({ id: request.result, ...data })
            request.onerror = () => reject(normalizeRequestError(request.error))
          }),
      )
    },
    findById(id: ID): Promise<Record<string, unknown> | undefined> {
      return guard(
        () =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(collection).get(id)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(normalizeRequestError(request.error))
          }),
      )
    },
    findAll(): Promise<Record<string, unknown>[]> {
      return guard(
        () =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(collection).getAll()
            request.onsuccess = () => resolve(request.result || [])
            request.onerror = () => reject(normalizeRequestError(request.error))
          }),
      )
    },
    update(id: ID, changes: Record<string, unknown>): Promise<Record<string, unknown>> {
      return guard(
        () =>
          new Promise((resolve, reject) => {
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
              putRequest.onerror = () => reject(normalizeRequestError(putRequest.error))
            }
            getRequest.onerror = () => reject(normalizeRequestError(getRequest.error))
          }),
      )
    },
    delete(id: ID): Promise<void> {
      return guard(
        () =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(collection).delete(id)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(normalizeRequestError(request.error))
          }),
      )
    },
  }
}
