import type { Model } from "../model/index"
import type { RelationShapes } from "../schema-types"
import type { CollectionSchema, QueryCondition, QueryOperator, SortSpec } from "../types"
import type { QueryExecutor } from "./executor"
import type { QueryPlanner } from "./planner"

interface QueryableCollection<T extends object, R extends RelationShapes> {
  readonly name: string
  _getSchema(): import("../schema").Schema | null
  _getAdapter(): import("../types").StorageAdapter
  _toModels(rawRecords: T[]): (Model<T, R> & T)[]
}

/** Keys of `T` whose value is a string. */
type StringKeys<T> = { [K in keyof T]-?: T[K] extends string ? K : never }[keyof T] & string

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

  async fetch(): Promise<(Model<T, R> & T)[]> {
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

    const rawRecords = await this.#executor.execute<T>(
      this.#collection._getAdapter(),
      this.#collection.name,
      plan,
    )

    return this.#collection._toModels(rawRecords)
  }

  async first(): Promise<(Model<T, R> & T) | undefined> {
    const results = await this.limit(1).fetch()
    return results[0]
  }

  async count(): Promise<number> {
    const results = await this.fetch()
    return results.length
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
}
