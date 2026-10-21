import type { Schema } from "../schema"
import type { DocOf, HasManyKeys, RelationShapes, ToOneKeys } from "../schema-types"
import type { ID } from "../types"

export class Model<
  T extends object = Record<string, unknown>,
  R extends RelationShapes = Record<never, never>,
> {
  #data: T
  #collection: {
    readonly name: string
    update(id: ID, changes: Partial<T>): Promise<Model<T, R> & T>
    delete(id: ID): Promise<void>
    _getSchema(): Schema | null
  }
  #database: {
    collection(name: string): unknown
  }
  #schema: Schema | null

  constructor(
    data: T,
    collection: {
      readonly name: string
      update(id: ID, changes: Partial<T>): Promise<Model<T, R> & T>
      delete(id: ID): Promise<void>
      _getSchema(): Schema | null
    },
    database: {
      collection(name: string): unknown
    },
    schema: Schema | null,
  ) {
    this.#data = data
    this.#collection = collection
    this.#database = database
    this.#schema = schema

    this.#attachRelationGetters()

    // biome-ignore lint/correctness/noConstructorReturn: returning Proxy for transparent data access
    return new Proxy(this, {
      get: (target, prop: string | symbol) => {
        if (prop === "constructor") {
          // Binding `constructor` made `model.constructor === Model` false
          // (audit M-12); it is metadata, not a method to call.
          return target.constructor
        }
        if (prop in target) {
          const val = (target as unknown as Record<string | symbol, unknown>)[prop]
          if (typeof val === "function") {
            return val.bind(target)
          }
          return val
        }
        return (target.#data as Record<string, unknown>)[prop as string]
      },

      set: (_target, prop: string | symbol, _value: unknown) => {
        // Silently accepting (and dropping) the write reported success while
        // losing data. Fail loudly instead; `.update()` is the supported path.
        if (prop === "id") return true
        throw new TypeError(
          `[ctrodb] Cannot assign "${String(prop)}" directly on a model. Use model.update({ ${String(prop)}: value }).`,
        )
      },

      has: (target, prop: string | symbol) =>
        prop in target || Object.hasOwn(target.#data, prop as string),

      // Without these two traps the record's fields were invisible to
      // `{...model}`, `Object.keys()`, `Object.entries()` and `JSON.stringify`
      // (audit M-12): only the class members and relation getters showed up.
      ownKeys: (target) => {
        const keys = new Set<string | symbol>(Reflect.ownKeys(target))
        for (const key of Object.keys(target.#data)) keys.add(key)
        return [...keys]
      },

      getOwnPropertyDescriptor: (target, prop: string | symbol) => {
        if (Object.hasOwn(target.#data, prop as string)) {
          return {
            value: (target.#data as Record<string, unknown>)[prop as string],
            enumerable: true,
            configurable: true,
            writable: false,
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, prop)
      },

      // Keep the synthetic keys read-only. Without these, `Object.assign`,
      // `defineProperty` or `delete` would create real own properties that
      // shadow (and outlive) the record data.
      defineProperty: (target, prop, descriptor) => {
        if (Object.hasOwn(target.#data, prop as string)) {
          throw new TypeError(
            `[ctrodb] Cannot redefine "${String(prop)}" on a model. Use model.update({ ${String(prop)}: value }).`,
          )
        }
        return Reflect.defineProperty(target, prop, descriptor)
      },

      deleteProperty: (target, prop: string | symbol) => {
        if (Object.hasOwn(target.#data, prop as string)) {
          throw new TypeError(
            `[ctrodb] Cannot delete "${String(prop)}" on a model. Use model.update() or model.delete().`,
          )
        }
        return Reflect.deleteProperty(target, prop)
      },
    })
  }

  get id(): ID {
    return (this.#data as Record<string, unknown>).id as ID
  }

  async update(changes: Partial<T>): Promise<Model<T, R> & T> {
    return this.#collection.update(this.id, changes)
  }

  async delete(): Promise<void> {
    await this.#collection.delete(this.id)
  }

  toJSON(): T {
    return { ...this.#data }
  }

  /**
   * Load a relation's records.
   *
   * `model.posts` is a lazy `QueryBuilder` (the shape it has always had) while
   * `collection.with("posts")` returns arrays. `load()` resolves either to
   * data, which removes the "two shapes" ambiguity (audit M-13):
   *
   *   const posts = await user.load("posts")        // arrays
   *   const author = await post.load("author")      // single model
   */
  async load<K extends HasManyKeys<R>>(name: K): Promise<(Model<DocOf<R[K]>> & DocOf<R[K]>)[]>
  async load<K extends ToOneKeys<R>>(
    name: K,
  ): Promise<(Model<DocOf<R[K]>> & DocOf<R[K]>) | undefined>
  async load(
    name: [keyof R] extends [never] ? string : never,
  ): Promise<Model<Record<string, unknown>>[] | Model<Record<string, unknown>> | undefined>
  async load(
    relationName: string,
  ): Promise<Model<Record<string, unknown>>[] | Model<Record<string, unknown>> | undefined> {
    const relation = (this as unknown as Record<string, unknown>)[relationName] as
      | { fetch(): Promise<Array<Model<Record<string, unknown>>>> }
      | undefined

    if (!relation || typeof relation.fetch !== "function") {
      throw new Error(
        `[ctrodb] "${String(relationName)}" is not a relation on collection "${this.#collection.name}"`,
      )
    }

    const records = await relation.fetch()
    const def = this.#schema?.getRelations(this.#collection.name)?.[relationName]
    return def?.type === "has_many" ? records : records[0]
  }

  #attachRelationGetters(): void {
    const relations = this.#schema?.getRelations(this.#collection.name)
    if (!relations) return

    for (const [name, def] of Object.entries(relations)) {
      Object.defineProperty(this, name, {
        get: () => {
          const relatedCollection = this.#database.collection(def.collection) as {
            query(): { where(field: string, op: string, value: unknown): unknown }
          }
          const query = relatedCollection.query()

          if (def.type === "has_many" || def.type === "has_one") {
            return query.where(def.foreignKey, "==", this.id)
          }

          if (def.type === "belongs_to") {
            const fkValue = (this.#data as Record<string, unknown>)[def.foreignKey]
            return query.where("id", "==", fkValue)
          }

          return undefined
        },
        configurable: true,
        enumerable: false,
      })
    }
  }
}
