import { createAdapter } from "./adapter/create"
import { Collection } from "./collection"
import { CollectionNotFoundError, ConnectionError } from "./errors"
import { QueryExecutor } from "./query/executor"
import { QueryPlanner } from "./query/planner"
import { Signal } from "./reactive/signal"
import { Schema } from "./schema"
import type { CollectionName, DocumentOf, RelationsOf } from "./schema-types"
import type { SyncEvent, SyncStatus } from "./sync/types"
import { TransactionPipeline } from "./transaction-context"
import type {
  ChangeEvent,
  ConnectionChangeEvent,
  CtroDBPlugin,
  ID,
  PluginStoreName,
  SchemaConfig,
  StorageAdapter,
  TransactionContext,
} from "./types"
import { LOCAL_WRITE } from "./write-context"

export interface DatabaseConfig<S extends SchemaConfig | undefined = SchemaConfig | undefined> {
  name?: string
  adapter?: "indexeddb" | "memory" | StorageAdapter
  /**
   * Schema for this database. Pass the result of `defineSchema()` to get
   * schema-derived document types; a plain object also works at runtime but its
   * literal field types are already widened, so derived types fall back to
   * `unknown`.
   */
  schema?: S
  plugins?: CtroDBPlugin[]
  logLevel?: "debug" | "info" | "warn" | "error" | "silent"
}

const DEFAULT_NAME = "ctrodb"

export class Database {
  readonly name: string
  #adapter: StorageAdapter
  #schema: Schema | null = null
  #planner = new QueryPlanner()
  #executor = new QueryExecutor()
  #collections = new Map<string, Collection<Record<string, unknown>>>()
  #plugins: CtroDBPlugin[] = []
  #changeSignal = new Signal<ChangeEvent | null>(null)
  #connectionChangeSignal = new Signal<ConnectionChangeEvent | null>(null)
  #connectionCleanup: Promise<void> = Promise.resolve()
  #connected = false

  constructor(config: DatabaseConfig = {}) {
    this.name = config.name ?? DEFAULT_NAME

    if (config.adapter && typeof config.adapter === "object" && "name" in config.adapter) {
      this.#adapter = config.adapter as StorageAdapter
    } else {
      this.#adapter = createAdapter(config.adapter as "indexeddb" | "memory" | undefined)
    }

    if (config.schema) {
      this.#schema = new Schema(config.schema)
    }

    if (config.plugins) {
      this.#plugins = config.plugins
    }

    this.#adapter.setConnectionChangeHandler?.((event) => this.#handleConnectionChange(event))
  }

  get isConnected(): boolean {
    return this.#connected
  }

  get adapterName(): string {
    return this.#adapter.name
  }

  async connect(): Promise<void> {
    await this.#connectionCleanup
    if (this.#connected) return

    const pluginStoreNames = this.#plugins.flatMap(
      (p: CtroDBPlugin & { storeNames?: PluginStoreName[] }) => p.storeNames ?? [],
    )

    const schemaConfig = this.#schema
      ? {
          version: this.#schema.version,
          collections: Object.fromEntries(
            Object.entries(this.#schema.collections).map(([name, col]) => [
              name,
              { fields: col.fields, indexes: col.indexes },
            ]),
          ) as Record<string, { fields: Record<string, unknown>; indexes?: unknown[] }>,
          pluginStoreNames,
        }
      : null

    await this.#adapter.connect(this.name, schemaConfig as unknown as SchemaConfig)

    try {
      for (const plugin of this.#plugins) {
        if (plugin.onDatabaseInit) {
          await plugin.onDatabaseInit(this)
        }
      }
    } catch (error) {
      // A failed initialisation must not leave a half-initialised instance
      // claiming to be connected: callers would then treat it as usable.
      await this.#adapter.disconnect().catch(() => {})
      this.#connected = false
      throw error
    }

    this.#connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.#connected) {
      await this.#connectionCleanup
      return
    }

    await this.#destroyPlugins()
    await this.#adapter.disconnect()
    this.#collections.clear()
    this.#connected = false
  }

  /**
   * Subscribe to external IndexedDB lifecycle changes.
   *
   * On `versionchange`, ctrodb closes its old connection and tears down
   * connection-scoped plugins. The instance becomes disconnected; reload the
   * app or call `connect()` with a schema at least as new as the upgraded DB.
   */
  onConnectionChange(callback: (event: ConnectionChangeEvent) => void): () => void {
    return this.#connectionChangeSignal.subscribe((event) => {
      if (event) callback(event)
    })
  }

  async #destroyPlugins(): Promise<void> {
    // Reverse registration order so listeners/timers stop before their deps.
    for (const plugin of [...this.#plugins].reverse()) {
      if (plugin.onDatabaseDestroy) {
        try {
          await plugin.onDatabaseDestroy(this)
        } catch (error) {
          console.error(`[ctrodb] plugin "${plugin.name}" failed to shut down:`, error)
        }
      }
    }
  }

  #handleConnectionChange(event: ConnectionChangeEvent): void {
    this.#connected = false
    this.#collections.clear()
    this.#connectionChangeSignal.value = event
    this.#connectionCleanup = this.#destroyPlugins()
  }

  collection<T extends object = Record<string, unknown>>(name: string): Collection<T> {
    if (!this.#connected) {
      throw new ConnectionError(this.name)
    }

    // A collection that is not declared in the schema cannot be validated,
    // indexed or migrated, yet it used to be created silently and accepted
    // unvalidated writes (audit M-05). Fail loudly with the available names.
    if (this.#schema && !this.#schema.collections[name] && !name.startsWith("_")) {
      throw new CollectionNotFoundError(name, Object.keys(this.#schema.collections))
    }

    let col = this.#collections.get(name) as Collection<T> | undefined
    if (!col) {
      col = new Collection<T>(
        name,
        this.#getDatabaseShim(),
        this.#adapter,
        this.#schema,
        this.#planner,
        this.#executor,
        this.#plugins,
      )
      this.#collections.set(name, col as Collection<Record<string, unknown>>)

      for (const plugin of this.#plugins) {
        if (plugin.onCollectionInit) {
          plugin.onCollectionInit(col)
        }
      }
    }
    return col as Collection<T>
  }

  /**
   * Run several writes atomically.
   *
   * The context behaves like the `Collection` API: schema defaults and
   * validation apply, plugin hooks run, and every committed write emits a
   * change event. Hooks and events are dispatched **after** the commit, so a
   * transaction that throws leaves neither an index entry nor an event behind.
   */
  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    this.#ensureConnected()

    let pipeline: TransactionPipeline | undefined
    const result = await this.#adapter.transaction((ctx) => {
      pipeline = new TransactionPipeline(ctx, {
        schema: this.#schema,
        plugins: this.#plugins,
        emit: (event) => this._emit(event),
        initializeCollection: (name) => {
          // The transaction context bypasses `Database.collection()`, but plugins
          // (notably FTS) rely on its onCollectionInit registration.
          this.collection(name)
        },
        context: LOCAL_WRITE,
      })
      return fn(pipeline)
    })

    // Only reached on commit: `adapter.transaction` rethrows (after rolling
    // back) when the callback throws.
    await pipeline?.flush()
    return result
  }

  on(callback: (event: ChangeEvent) => void): () => void {
    return this.#changeSignal.subscribe((event) => {
      if (event) callback(event)
    })
  }

  plugin(name: string): CtroDBPlugin | undefined {
    return this.#plugins.find((p) => p.name === name)
  }

  async sync(): Promise<void> {
    const p = this.plugin("sync") as { _engine?: { sync(): Promise<void> } } | undefined
    if (p?._engine?.sync) {
      return p._engine.sync()
    }
    throw new Error("Sync plugin not registered or not initialized")
  }

  onSync(callback: (event: SyncEvent) => void): () => void {
    const p = this.plugin("sync") as
      | { _engine?: { onEvent(cb: (event: SyncEvent) => void): () => void } }
      | undefined
    if (p?._engine?.onEvent) {
      return p._engine.onEvent(callback)
    }
    throw new Error("Sync plugin not registered or not initialized")
  }

  get syncStatus(): SyncStatus {
    const p = this.plugin("sync") as { _engine?: { status: SyncStatus } } | undefined
    if (p?._engine?.status) {
      return p._engine.status
    }
    throw new Error("Sync plugin not registered or not initialized")
  }

  async getPendingCount(): Promise<number> {
    const p = this.plugin("sync") as
      | { _engine?: { getPendingCount(): Promise<number> } }
      | undefined
    if (p?._engine?.getPendingCount) {
      return p._engine.getPendingCount()
    }
    return 0
  }

  async getFailedCount(): Promise<number> {
    const p = this.plugin("sync") as { _engine?: { getFailedCount(): Promise<number> } } | undefined
    if (p?._engine?.getFailedCount) {
      return p._engine.getFailedCount()
    }
    return 0
  }

  _getSchema(): Schema | null {
    return this.#schema
  }

  _getAdapter(): StorageAdapter {
    return this.#adapter
  }

  /**
   * Ask the plugins whether one of them can answer token queries.
   *
   * The first plugin that implements `queryTokens` wins; when none does, the
   * lookup returns `undefined` and `query().match()` scans instead.
   */
  async _queryTokens(
    collection: string,
    query: string,
    fields?: string[],
  ): Promise<ID[] | undefined> {
    for (const plugin of this.#plugins) {
      if (typeof plugin.queryTokens === "function") {
        const ids = await plugin.queryTokens(collection, query, fields)
        // `undefined` means "this plugin does not index that collection (or
        // those fields)": stop and let the caller scan, rather than returning
        // an empty set that would look like "no matches".
        if (ids) return ids
      }
    }
    return undefined
  }

  _emit(event: ChangeEvent): void {
    this.#changeSignal.value = event
  }

  #getDatabaseShim() {
    return {
      name: this.name,
      _getSchema: () => this.#schema,
      _emit: (event: ChangeEvent) => this._emit(event),
      collection: (name: string) => this.collection(name),
      _queryTokens: (collection: string, query: string, fields?: string[]) =>
        this._queryTokens(collection, query, fields),
    }
  }

  #ensureConnected(): void {
    if (!this.#connected) {
      throw new ConnectionError(this.name)
    }
  }
}

/**
 * A `Database` whose `collection()` is typed from its schema.
 *
 * This is a subclass rather than a generic `Database<S>` on purpose: a generic
 * database would be invariant in `S`, so a typed instance could not be passed
 * to any function that accepts a plain `Database` — which is most of the API
 * (`inspectSyncQueue`, `DatabaseProvider`, sync transports, user helpers).
 * Extending keeps `TypedDatabase<S>` a `Database` everywhere.
 */
export class TypedDatabase<S extends SchemaConfig> extends Database {
  declare readonly __schema?: S

  override collection<K extends CollectionName<S>>(
    name: K,
  ): Collection<DocumentOf<S, K>, RelationsOf<S, K>>
  // Kept so that `TypedDatabase<S>` remains assignable to `Database` (a class
  // generic would be invariant and could not be passed to helpers or context
  // providers). An undeclared name therefore still compiles here, and fails at
  // runtime with `CollectionNotFoundError` — the same contract as before.
  override collection<T extends object = Record<string, unknown>>(name: string): Collection<T>
  override collection<T extends object = Record<string, unknown>>(name: string): Collection<T> {
    return super.collection<T>(name)
  }
}

/**
 * Create a database whose collections are typed from its schema.
 *
 * ```ts
 * const schema = defineSchema({ version: 1, collections: { … } })
 * const db = createDatabase({ name: "app", schema, adapter: "indexeddb" })
 * const todos = db.collection("todos")   // document type inferred from the schema
 * ```
 *
 * The `const` type parameter preserves the schema's literal field types even
 * when the config is written inline.
 */
export function createDatabase<const S extends SchemaConfig>(
  config: DatabaseConfig & { schema: S },
): TypedDatabase<S> {
  return new TypedDatabase<S>(config)
}
