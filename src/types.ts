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
  pluginStoreNames?: string[]
}

export type QueryOperator = "==" | "!=" | ">" | "<" | ">=" | "<="

export interface QueryCondition {
  type: "where" | "search"
  field: string
  op?: QueryOperator
  value: unknown
}

export type QueryStrategy = "index_scan" | "full_scan" | "id_lookup"

export interface SortSpec {
  field: string
  direction: "asc" | "desc"
}

export interface QueryPlan {
  strategy: QueryStrategy
  indexName?: string
  range?: IDBKeyRange
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

export interface CtroDBPlugin {
  name: string
  version?: string
  storeNames?: string[]
  onDatabaseInit?(db: unknown): void
  onCollectionInit?(collection: unknown): void
  onBeforeCreate?(collection: string, data: unknown): unknown
  onAfterCreate?(collection: string, record: unknown): void
  onBeforeUpdate?(collection: string, id: ID, changes: unknown): unknown
  onAfterUpdate?(collection: string, id: ID, record: unknown, oldRecord?: unknown): void
  onBeforeDelete?(collection: string, id: ID): void
  onAfterDelete?(collection: string, id: ID, oldRecord?: unknown): void
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
    range: IDBKeyRange | undefined,
    postFilters: QueryCondition[],
  ): Promise<unknown[]>
  transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T>
  getMetadata(key: string): Promise<unknown>
  setMetadata(key: string, value: unknown): Promise<void>
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"
