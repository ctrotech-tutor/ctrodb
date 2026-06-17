export const VERSION = "1.0.0-alpha.1"

export {
  CollectionNotFoundError,
  ConnectionError,
  CtrodbError,
  QueryError,
  RecordNotFoundError,
  SchemaError,
  ValidationError,
} from "./errors"
export { Signal } from "./reactive/signal"
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
