export type ID = number | string

export type FieldType = "string" | "number" | "boolean" | "object" | "array"

export interface FieldDefinition {
  type: FieldType
  required?: boolean
  default?: unknown
  validate?: "email" | "url" | RegExp | ((value: unknown) => boolean)
  min?: number
  max?: number
  maxLength?: number
  items?: FieldDefinition
  unique?: boolean
}

export interface IndexDefinition {
  field: string
  unique?: boolean
}

export type RelationType = "has_many" | "belongs_to" | "has_one"

export interface RelationDefinition {
  type: RelationType
  collection: string
  foreignKey: string
}

export interface CollectionSchema {
  fields: Record<string, FieldDefinition>
  indexes?: IndexDefinition[]
  searchable?: string[]
  relations?: Record<string, RelationDefinition>
}

export interface SchemaConfig {
  version: number
  collections: Record<string, CollectionSchema>
  pluginStoreNames?: PluginStoreName[]
}

export type QueryOperator = "==" | "!=" | ">" | "<" | ">=" | "<="

/**
 * One filter in a query.
 *
 * - `where`  — field/operator/value comparison.
 * - `search` — case-insensitive **substring** match on one field.
 * - `match`  — tokenised **AND** match across a set of fields (`fields`), which
 *   the full-text index can answer without scanning the collection.
 *   `field` is the first field for display purposes only.
 */
export interface QueryCondition {
  type: "where" | "search" | "match"
  field: string
  op?: QueryOperator
  value: unknown
  /** Fields a `match` condition applies to. */
  fields?: string[]
}

export type QueryStrategy = "index_scan" | "full_scan" | "id_lookup"

/**
 * A value that can be used as an index key.
 *
 * Deliberately narrower than `IDBValidKey`: ctrodb only builds ranges from
 * scalar field values (string, number, Date). Booleans, `null`, objects and
 * arrays are not valid IndexedDB keys, so conditions on them must never
 * produce an index scan.
 */
export type QueryKey = string | number | Date

/**
 * Storage-neutral description of a key range.
 *
 * The core never constructs `IDBKeyRange`; it builds one of these instead and
 * lets each adapter interpret it. This is what allows the memory adapter (and
 * therefore Node) to run indexed queries in environments without IndexedDB.
 *
 * The shape is structurally compatible with the four bound properties of
 * `IDBKeyRange`, so existing adapter implementations that only read
 * `lower`/`upper`/`lowerOpen`/`upperOpen` keep working.
 */
export interface QueryRange {
  readonly lower?: QueryKey
  readonly upper?: QueryKey
  readonly lowerOpen: boolean
  readonly upperOpen: boolean
}

export interface SortSpec {
  field: string
  direction: "asc" | "desc"
}

export interface QueryPlan {
  strategy: QueryStrategy
  indexName?: string
  range?: QueryRange
  primaryConditions: QueryCondition[]
  postFilterConditions: QueryCondition[]
  sort?: SortSpec
  limit?: number
  offset?: number
  groupType: "single" | "or"
  groups?: QueryPlan[]
}

export type ChangeType = "create" | "update" | "delete"

export interface ChangeEvent {
  type: ChangeType
  collection: string
  recordId: ID
  record?: unknown
  oldRecord?: unknown
}

export interface PluginStoreConfig {
  name: string
  indexes?: IndexDefinition[]
}

export type PluginStoreName = string | PluginStoreConfig

/**
 * Where a write came from.
 *
 * `"local"` — a caller used the Collection API (user intent).
 * `"remote"` — the sync engine applied data received from a transport.
 *
 * Hooks receive a {@link WriteContext} as their final argument so plugins can
 * avoid reacting to their own applied changes (e.g. re-queueing synced data).
 */
export type WriteOrigin = "local" | "remote"

export interface WriteContext {
  readonly origin: WriteOrigin
}

export interface CtroDBPlugin {
  name: string
  version?: string
  storeNames?: PluginStoreName[]
  onDatabaseInit?(db: unknown): void | Promise<void>
  /** Called from `db.disconnect()` in reverse registration order. */
  onDatabaseDestroy?(db: unknown): void | Promise<void>
  onCollectionInit?(collection: unknown): void
  onBeforeCreate?(collection: string, data: unknown, context?: WriteContext): unknown
  onAfterCreate?(collection: string, record: unknown, context?: WriteContext): void
  onBeforeUpdate?(collection: string, id: ID, changes: unknown, context?: WriteContext): unknown
  onAfterUpdate?(
    collection: string,
    id: ID,
    record: unknown,
    oldRecord?: unknown,
    context?: WriteContext,
  ): void
  onBeforeDelete?(collection: string, id: ID, context?: WriteContext): void
  onAfterDelete?(collection: string, id: ID, oldRecord?: unknown, context?: WriteContext): void
  /**
   * Resolve a tokenised collection-wide query to candidate document ids.
   *
   * Optional capability: a plugin that maintains a token index (`ftsPlugin()`)
   * implements it, and `query().match()` then answers from the index instead of
   * scanning. Results are treated as **candidates** — the query predicate runs
   * on them afterwards — so an implementation may return a superset but never
   * a subset.
   */
  queryTokens?(collection: string, query: string, fields?: string[]): Promise<ID[] | undefined>
}

/**
 * The scoped handle a transaction exposes for one collection.
 *
 * All operations run inside the transaction and participate in its commit or
 * rollback. Both shipped adapters implement this identically.
 */
export interface TransactionCollection {
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>
  findById(id: ID): Promise<Record<string, unknown> | undefined>
  findAll(): Promise<Record<string, unknown>[]>
  update(id: ID, changes: Record<string, unknown>): Promise<Record<string, unknown>>
  delete(id: ID): Promise<void>
}

export interface TransactionContext {
  collection(name: string): TransactionCollection
}

export interface StorageAdapter {
  readonly name: string
  connect(name: string, schema: SchemaConfig | null): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  getSchemaVersion(): Promise<number>
  setSchemaVersion(version: number): Promise<void>
  create(collection: string, data: unknown): Promise<unknown>
  findById(collection: string, id: ID): Promise<unknown>
  /**
   * Read several records in one operation.
   *
   * Optional, and additive: callers fall back to one `findById` per id. It
   * exists because a bulk delete needs the previous records for its events, and
   * N separate `findById` calls are N separate IndexedDB transactions.
   */
  findByIds?(collection: string, ids: ID[]): Promise<(unknown | undefined)[]>
  findAll(collection: string): Promise<unknown[]>
  /**
   * Number of rows in a collection.
   *
   * Optional: adapters that can answer this without materialising every row
   * should implement it (`Collection.count()` then stops copying the whole
   * collection just to read `.length`). Adapters that do not are still
   * supported and counted through `findAll()`.
   */
  count?(collection: string): Promise<number>
  /**
   * Whether `collection` has an index on `indexName`.
   *
   * Optional. Plugins use it to decide between an indexed lookup and a scan
   * (the search index asks whether its posting store is queryable by token).
   * Adapters that do not implement it are treated as "no index".
   */
  hasIndex?(collection: string, indexName: string): boolean
  update(collection: string, id: ID, changes: unknown): Promise<unknown>
  delete(collection: string, id: ID): Promise<void>
  deleteMany(collection: string, ids: ID[]): Promise<void>
  scanIndex(
    collection: string,
    indexName: string,
    range: QueryRange | undefined,
    postFilters: QueryCondition[],
  ): Promise<unknown[]>
  transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T>
  getMetadata(key: string): Promise<unknown>
  setMetadata(key: string, value: unknown): Promise<void>
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"
