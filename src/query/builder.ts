import { QueryError } from "../errors"
import type { ModelInstance } from "../model/index"
import type { RelationShapes } from "../schema-types"
import type { CollectionSchema, QueryCondition, QueryOperator, SortSpec } from "../types"
import type { QueryExecutor, TokenSearch } from "./executor"
import type { QueryPlanner } from "./planner"

interface QueryableCollection<T extends object, R extends RelationShapes> {
  readonly name: string
  _getSchema(): import("../schema").Schema | null
  _getAdapter(): import("../types").StorageAdapter
  _toModels(rawRecords: T[]): ModelInstance<T, R>[]
  count(): Promise<number>
  /** Token index for this collection, when a plugin provides one. */
  _queryTokens?(): TokenSearch | undefined
}

/**
 * Keys of `T` whose value is a string.
 *
 * `NonNullable` matters: a field that is not `required` is optional on the
 * document type, so its value is `string | undefined`, and a plain
 * `extends string` check turns every such field into `never` — which made
 * `search()` (and `match()`) unusable on the most common kind of field.
 */
type StringKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends string ? K : never
}[keyof T] &
  string

export class QueryBuilder<T extends object, R extends RelationShapes = Record<never, never>> {
  #conditionGroups: QueryCondition[][] = [[]]
  #sortSpec: SortSpec | undefined
  #limitValue: number | undefined
  #offsetValue: number | undefined
  #collection: QueryableCollection<T, R>
  #planner: QueryPlanner
  #executor: QueryExecutor

  constructor(
    collection: QueryableCollection<T, R>,
    planner: QueryPlanner,
    executor: QueryExecutor,
  ) {
    this.#collection = collection
    this.#planner = planner
    this.#executor = executor
  }

  /**
   * Filter by field.
   *
   * The field name and the value are typed from the collection's document
   * type, so `where("age", ">", "18")` and `where("nope", 1)` are compile
   * errors instead of empty result sets (audit M-14).
   */
  where(field: "id", value: import("../types").ID | undefined): this
  where(field: "id", op: QueryOperator, value: import("../types").ID | undefined): this
  where<K extends keyof T & string>(field: K, value: T[K]): this
  where<K extends keyof T & string>(field: K, op: QueryOperator, value: T[K]): this
  where(field: string, opOrValue: unknown, value?: unknown): this {
    const supportedOps = ["==", "!=", ">", "<", ">=", "<="]
    let op: string
    let val: unknown

    if (value === undefined) {
      op = "=="
      val = opOrValue
    } else {
      op = opOrValue as string
      val = value
    }

    if (!supportedOps.includes(op)) {
      throw new Error(
        `Unsupported operator '${op}'. Supported operators: ${supportedOps.join(", ")}`,
      )
    }

    const lastGroup = this.#conditionGroups[this.#conditionGroups.length - 1] ?? []
    lastGroup.push({ type: "where", field, op: op as QueryCondition["op"], value: val })
    return this
  }

  orWhere(callback: (q: QueryBuilder<T>) => void): this {
    const childBuilder = new QueryBuilder<T, R>(this.#collection, this.#planner, this.#executor)
    callback(childBuilder)

    const newGroup = childBuilder.#conditionGroups[0]
    if (newGroup && newGroup.length > 0) {
      this.#conditionGroups.push(newGroup)
    }
    return this
  }

  sort(spec: Partial<Record<keyof T, "asc" | "desc">>): this {
    const entries = Object.entries(spec)
    if (entries.length > 0) {
      const [field, direction] = entries[0] as [string, "asc" | "desc"]
      this.#sortSpec = { field, direction: direction || "asc" }
    }
    return this
  }

  limit(n: number): this {
    this.#limitValue = n
    return this
  }

  offset(n: number): this {
    this.#offsetValue = n
    return this
  }

  async fetch(): Promise<ModelInstance<T, R>[]> {
    const rawRecords = await this.#run()
    return this.#collection._toModels(rawRecords)
  }

  /**
   * Run the plan and return the raw rows.
   *
   * Split out of `fetch()` so `count()` does not pay to wrap every row in a
   * `Model` (a Proxy) only to discard it.
   */
  async #run(): Promise<T[]> {
    const collectionSchema = this.#collection._getSchema()
    const schema: CollectionSchema | null = collectionSchema
      ? {
          fields: collectionSchema.collections[this.#collection.name]?.fields ?? {},
          indexes: collectionSchema.getIndexes(this.#collection.name),
          searchable: collectionSchema.getSearchableFields(this.#collection.name),
          relations: collectionSchema.getRelations(this.#collection.name),
        }
      : null

    const indexes = collectionSchema ? collectionSchema.getIndexes(this.#collection.name) : []

    const plan = this.#planner.plan(this.#conditionGroups, schema, indexes)
    plan.sort = this.#sortSpec
    plan.limit = this.#limitValue
    plan.offset = this.#offsetValue

    return this.#executor.execute<T>(
      this.#collection._getAdapter(),
      this.#collection.name,
      plan,
      this.#collection._queryTokens?.(),
    )
  }

  async first(): Promise<ModelInstance<T, R> | undefined> {
    const results = await this.limit(1).fetch()
    return results[0]
  }

  async count(): Promise<number> {
    // An unfiltered, unwindowed query is just the collection size.
    const empty = this.#conditionGroups.every((group) => group.length === 0)
    if (
      empty &&
      !this.#sortSpec &&
      this.#limitValue === undefined &&
      this.#offsetValue === undefined
    ) {
      return this.#collection.count()
    }
    return (await this.#run()).length
  }

  async toArray(): Promise<T[]> {
    const results = await this.fetch()
    return results.map((model) => model.toJSON())
  }

  /**
   * Case-insensitive substring filter on one **string** field.
   *
   * The field is restricted to string-valued keys because searching a number or
   * boolean field can never match (audit M-15 documents the semantics).
   */
  search<K extends StringKeys<T>>(field: K, query: string): this
  search(field: string, query: string): this {
    const lastGroup = this.#conditionGroups[this.#conditionGroups.length - 1] ?? []
    lastGroup.push({ type: "search", field, value: query })
    return this
  }

  /**
   * Tokenised **AND** match, answered by the full-text index when it is present.
   *
   * Every token of `query` must appear as a whole word in the searched fields,
   * so `match("quick fox")` finds "the quick brown fox" but not "quickfix".
   * `search()` remains the substring filter; this is the word-aware one.
   *
   * ```ts
   * await articles.query().match("typescript database").fetch()
   * await articles.query().match("typescript", ["title"]).fetch()
   * ```
   *
   * Without `fields`, the collection's declared `searchable` fields are used —
   * the same fields `ftsPlugin()` indexes — so installing the plugin changes how
   * fast this runs, never what it returns.
   */
  match(query: string, fields?: readonly StringKeys<T>[]): this {
    const schema = this.#collection._getSchema()
    const collectionSchema = schema?.collections[this.#collection.name]

    let resolved: string[]
    if (fields) {
      resolved = [...fields]
      if (resolved.length === 0) {
        throw new QueryError(
          'match() needs at least one field (pass ["field"], or omit for `searchable`)',
        )
      }
      const unknown = resolved.filter(
        (field) => collectionSchema && !collectionSchema.fields?.[field],
      )
      if (unknown.length > 0) {
        throw new QueryError(
          `match() references ${unknown.length === 1 ? "a field" : "fields"} that ${this.#collection.name} does not declare: ${unknown.join(", ")}`,
        )
      }
    } else {
      resolved = collectionSchema?.searchable ?? []
      if (resolved.length === 0) {
        throw new QueryError(
          `match() on "${this.#collection.name}" needs fields: none are declared as \`searchable\` in the schema. ` +
            'Add them to the collection\'s `searchable` array, or call match(query, ["field"]).',
        )
      }
    }

    const lastGroup = this.#conditionGroups[this.#conditionGroups.length - 1] ?? []
    lastGroup.push({ type: "match", field: resolved[0] ?? "", value: query, fields: resolved })
    return this
  }
}
