/**
 * Type-level view of a schema.
 *
 * The runtime never imports these helpers: they exist so that a schema declared
 * once with {@link defineSchema} produces the document type, the collection
 * names and the relation shapes without any hand-written interfaces.
 *
 * ```ts
 * const schema = defineSchema({
 *   version: 1,
 *   collections: {
 *     todos: {
 *       fields: {
 *         text: { type: "string", required: true },
 *         done: { type: "boolean", default: false },
 *       },
 *     },
 *   },
 * })
 *
 * const db = new Database({ schema })
 * const todos = db.collection("todos")   // Collection<{ id: ID; text: string; done: boolean }>
 * todos.create({ text: "hi" })           // { done: false } is optional, `text` is not
 * db.collection("tdoos")                 // type error, listing the declared names
 * ```
 */
import { Schema } from "./schema"
import type {
  CollectionSchema,
  FieldDefinition,
  RelationDefinition,
  RelationType,
  SchemaConfig,
} from "./types"

// ── Field → value ──

/** TypeScript type produced by a `FieldType` keyword. */
export type FieldValue<F extends FieldDefinition> = F["type"] extends "string"
  ? string
  : F["type"] extends "number"
    ? number
    : F["type"] extends "boolean"
      ? boolean
      : F["type"] extends "array"
        ? F extends { items: infer I }
          ? I extends FieldDefinition
            ? FieldValue<I>[]
            : unknown[]
          : unknown[]
        : F["type"] extends "object"
          ? Record<string, unknown>
          : unknown

/**
 * Fields that must be supplied to `create()` and are always present on a
 * freshly written record: `required: true`.
 *
 * A `default` is applied by `create()` but deliberately stays optional in the
 * type: records written before the default was declared (and rows arriving
 * through sync) may not have the field.
 */
type AlwaysPresent<F> = F extends { required: true } ? true : false

/** Stored/read shape of a collection, including the generated `id`. */
export type InferRecord<C> = C extends { fields: infer F }
  ? { id: import("./types").ID } & {
      [K in keyof F as AlwaysPresent<F[K]> extends true ? K : never]: FieldValue<
        F[K] & FieldDefinition
      >
    } & {
      [K in keyof F as AlwaysPresent<F[K]> extends true ? never : K]?: FieldValue<
        F[K] & FieldDefinition
      >
    }
  : { id: import("./types").ID } & Record<string, unknown>

/** Stored/read shape of one collection of a schema. */
export type DocumentOf<S, K extends PropertyKey> = [S] extends [SchemaConfig]
  ? K extends keyof S["collections"]
    ? InferRecord<S["collections"][K]>
    : Record<string, unknown>
  : Record<string, unknown>

/** Every collection name declared by a schema. */
export type CollectionName<S> = [S] extends [SchemaConfig]
  ? keyof S["collections"] & string
  : string

// ── Relations ──

/** What a relation resolves to, in data terms. */
export interface RelationShape {
  type: RelationType
  doc: object
}

/** Relation name → resolved shape, as carried by `Model` and `Collection`. */
export type RelationShapes = Record<string, RelationShape>

type EmptyRelations = Record<never, never>

type RelationDefsOf<S, K extends PropertyKey> = [S] extends [SchemaConfig]
  ? K extends keyof S["collections"]
    ? S["collections"][K] extends { relations: infer R }
      ? R
      : EmptyRelations
    : EmptyRelations
  : EmptyRelations

/** Relation map for one collection: name → `{ type, doc }`. */
export type RelationsOf<S, K extends PropertyKey> = {
  [N in keyof RelationDefsOf<S, K> & string]: {
    type: RelationDefsOf<S, K>[N] extends { type: infer T extends RelationType } ? T : RelationType
    doc: RelationDefsOf<S, K>[N] extends { collection: infer C }
      ? DocumentOf<S, C & PropertyKey>
      : Record<string, unknown>
  }
}

// ── defineSchema ──

/**
 * Declare a schema and keep its literal types.
 *
 * `const` inference is what makes the derived document types precise: without
 * it, `{ type: "string" }` widens to `{ type: string }` and every field would
 * resolve to `unknown`.
 *
 * The configuration is validated immediately (unknown field types, indexes or
 * relations pointing at things that do not exist), so a mistake surfaces where
 * the schema is defined instead of at `connect()`.
 */
export function defineSchema<const S extends SchemaConfig>(schema: S): S {
  // Validation only: the returned object is the caller's own literal, so the
  // inferred types stay exact.
  new Schema(schema)
  return schema
}

/** Relation names that resolve to an array (`has_many`). */
export type HasManyKeys<R> = {
  [K in keyof R]: R[K] extends { type: "has_many" } ? K : never
}[keyof R] &
  string

/** Relation names that resolve to a single record (`has_one`, `belongs_to`). */
export type ToOneKeys<R> = {
  [K in keyof R]: R[K] extends { type: "has_many" } ? never : K
}[keyof R] &
  string

/** Document type carried by a relation shape. */
export type DocOf<X> = X extends { doc: infer D }
  ? D extends object
    ? D
    : Record<string, unknown>
  : Record<string, unknown>

/** Narrowing helper used by the public API overloads. */
export type AnySchema = SchemaConfig

export type { CollectionSchema, RelationDefinition }
