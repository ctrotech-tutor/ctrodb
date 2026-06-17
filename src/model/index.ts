import type { Schema } from "../schema"
import type { ID } from "../types"

export class Model<T extends Record<string, unknown> = Record<string, unknown>> {
  #data: T
  #collection: {
    readonly name: string
    update(id: ID, changes: Partial<T>): Promise<Model<T>>
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
      update(id: ID, changes: Partial<T>): Promise<Model<T>>
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
        if (prop in target) {
          const val = (target as unknown as Record<string | symbol, unknown>)[prop]
          if (typeof val === "function") {
            return val.bind(target)
          }
          return val
        }
        return target.#data[prop as string]
      },
      set: (_target, prop: string | symbol, _value: unknown) => {
        if (prop !== "id") {
          console.warn(
            `[ctrodb] Direct property assignment is not allowed. Use .update() instead. Field: "${String(prop)}"`,
          )
        }
        return true
      },
    })
  }

  get id(): ID {
    return (this.#data as Record<string, unknown>).id as ID
  }

  async update(changes: Partial<T>): Promise<Model<T>> {
    return this.#collection.update(this.id, changes)
  }

  async delete(): Promise<void> {
    await this.#collection.delete(this.id)
  }

  toJSON(): T {
    return { ...this.#data }
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
        enumerable: true,
      })
    }
  }
}
