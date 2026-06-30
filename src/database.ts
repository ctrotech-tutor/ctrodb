import { createAdapter } from "./adapter/create"
import { Collection } from "./collection"
import { ConnectionError } from "./errors"
import { QueryExecutor } from "./query/executor"
import { QueryPlanner } from "./query/planner"
import { Signal } from "./reactive/signal"
import { Schema } from "./schema"
import type { SyncEvent, SyncStatus } from "./sync/types"
import type {
  ChangeEvent,
  CtroDBPlugin,
  PluginStoreName,
  SchemaConfig,
  StorageAdapter,
  TransactionContext,
} from "./types"

export interface DatabaseConfig {
  name?: string
  adapter?: "indexeddb" | "memory" | StorageAdapter
  schema?: SchemaConfig
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
  }

  get isConnected(): boolean {
    return this.#connected
  }

  get adapterName(): string {
    return this.#adapter.name
  }

  async connect(): Promise<void> {
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

    this.#connected = true

    for (const plugin of this.#plugins) {
      if (plugin.onDatabaseInit) {
        await plugin.onDatabaseInit(this)
      }
    }
  }

  async disconnect(): Promise<void> {
    if (!this.#connected) return

    await this.#adapter.disconnect()
    this.#collections.clear()
    this.#connected = false
  }

  collection<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
  ): Collection<T> {
    if (!this.#connected && name !== "_create") {
      throw new ConnectionError(this.name)
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
    return col
  }

  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    this.#ensureConnected()
    return this.#adapter.transaction(fn)
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

  _emit(event: ChangeEvent): void {
    this.#changeSignal.value = event
  }

  #getDatabaseShim() {
    return {
      name: this.name,
      _getSchema: () => this.#schema,
      _emit: (event: ChangeEvent) => this._emit(event),
      collection: (name: string) => this.collection(name),
    }
  }

  #ensureConnected(): void {
    if (!this.#connected) {
      throw new ConnectionError(this.name)
    }
  }
}
