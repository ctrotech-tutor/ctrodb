export const VERSION = "1.0.1"

export { createAdapter, IndexedDBAdapter, MemoryAdapter } from "./adapter/index"
export { Collection } from "./collection"
export type { DatabaseConfig } from "./database"
export { Database } from "./database"
export {
  CollectionNotFoundError,
  ConnectionError,
  CtrodbError,
  QueryError,
  RecordNotFoundError,
  SchemaError,
  ValidationError,
} from "./errors"
export { Model } from "./model/index"
export type { ValidationRule } from "./plugins/index"
export {
  FTSIndexer,
  ftsPlugin,
  RelationsEngine,
  relationsPlugin,
  tokenize,
  ValidationEngine,
  validationPlugin,
} from "./plugins/index"
export { QueryBuilder, QueryExecutor, QueryPlanner } from "./query/index"
export { Signal } from "./reactive/signal"
export { Schema } from "./schema"
export type {
  ConflictResolution,
  ConflictResolverFn,
  ConflictStrategy,
  HttpTransportConfig,
  PullOptions,
  PushOptions,
  WsTransportConfig,
  SyncChangeRecord,
  SyncChangeStatus,
  SyncChangeType,
  SyncConflict,
  SyncEvent,
  SyncEventLogEntry,
  SyncPhase,
  SyncPluginConfig,
  SyncProgress,
  SyncPullResult,
  SyncPushResult,
  SyncQueueSnapshot,
  SyncQueueStats,
  SyncStatus,
  SyncTransport,
} from "./sync/index"

// Sync
export {
  ChangeTracker,
  clearCommittedSync,
  compactSyncQueue,
  ConflictResolverEngine,
  createSyncEventLog,
  getSyncStats,
  HttpTransport,
  inspectSyncQueue,
  retryFailedSync,
  SyncEngine,
  SYNC_STORE,
  syncPlugin,
  WsTransport,
} from "./sync/index"
export type {
  ChangeEvent,
  ChangeType,
  CollectionSchema,
  CtroDBPlugin,
  FieldDefinition,
  FieldType,
  ID,
  IndexDefinition,
  LogLevel,
  QueryCondition,
  QueryOperator,
  QueryPlan,
  QueryStrategy,
  RelationDefinition,
  RelationType,
  SchemaConfig,
  SortSpec,
  StorageAdapter,
  TransactionContext,
} from "./types"
