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

export interface QueryCondition {
  type: "where" | "search"
  field: string
  op?: QueryOperator
  value: unknown
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
  onDatabaseInit?(db: unknown): void
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
}

export interface TransactionContext {
  collection(name: string): unknown
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
  findAll(collection: string): Promise<unknown[]>
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
