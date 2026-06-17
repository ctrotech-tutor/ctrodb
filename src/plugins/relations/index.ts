import type { Collection } from "../../collection"
import type { Database } from "../../database"
import type { Model } from "../../model/index"
import type { CtroDBPlugin, ID } from "../../types"

export class RelationsEngine {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  async eagerLoad<T extends Record<string, unknown>>(
    models: Array<Model<T> & T>,
    collectionName: string,
    relationsToLoad: string[],
  ): Promise<void> {
    if (models.length === 0 || relationsToLoad.length === 0) return
    const schema = this.#db._getSchema()
    if (!schema) return

    for (const relationName of relationsToLoad) {
      const def = schema.getRelations(collectionName)?.[relationName]
      if (!def) continue
      switch (def.type) {
        case "belongs_to":
          await this.#eagerLoadBelongsTo(models, def.collection, def.foreignKey, relationName)
          break
        case "has_many":
          await this.#eagerLoadHasMany(models, def.collection, def.foreignKey, relationName)
          break
        case "has_one":
          await this.#eagerLoadHasOne(models, def.collection, def.foreignKey, relationName)
          break
      }
    }
  }

  async #eagerLoadBelongsTo<T extends Record<string, unknown>>(
    models: Array<Model<T> & T>,
    targetCollection: string,
    foreignKey: string,
    relationName: string,
  ): Promise<void> {
    const fks = models
      .map((m) => (m as Record<string, unknown>)[foreignKey] as ID | undefined)
      .filter((id): id is ID => id != null)
    if (fks.length === 0) return

    const all = await this.#db.collection(targetCollection).getAll()
    const map = new Map(all.map((r) => [r.id, r]))
    for (const model of models) {
      const fk = (model as Record<string, unknown>)[foreignKey] as ID | undefined
      if (fk !== undefined) {
        Object.defineProperty(model, relationName, {
          value: map.get(fk),
          enumerable: true,
          configurable: true,
        })
      }
    }
  }

  async #eagerLoadHasMany<T extends Record<string, unknown>>(
    models: Array<Model<T> & T>,
    targetCollection: string,
    foreignKey: string,
    relationName: string,
  ): Promise<void> {
    const ids = models.map((m) => m.id).filter((id): id is ID => id != null)
    if (ids.length === 0) return

    const all = await this.#db.collection(targetCollection).getAll()
    const grouped = new Map<ID, typeof all>()
    for (const r of all) {
      const fk = (r as Record<string, unknown>)[foreignKey] as ID | undefined
      if (fk !== undefined) {
        if (!grouped.has(fk)) grouped.set(fk, [])
        grouped.get(fk)?.push(r)
      }
    }
    for (const model of models) {
      Object.defineProperty(model, relationName, {
        value: grouped.get(model.id) ?? [],
        enumerable: true,
        configurable: true,
      })
    }
  }

  async #eagerLoadHasOne<T extends Record<string, unknown>>(
    models: Array<Model<T> & T>,
    targetCollection: string,
    foreignKey: string,
    relationName: string,
  ): Promise<void> {
    const ids = models.map((m) => m.id).filter((id): id is ID => id != null)
    if (ids.length === 0) return

    const all = await this.#db.collection(targetCollection).getAll()
    const grouped = new Map<ID, (typeof all)[0]>()
    for (const r of all) {
      const fk = (r as Record<string, unknown>)[foreignKey] as ID | undefined
      if (fk !== undefined && !grouped.has(fk)) grouped.set(fk, r)
    }
    for (const model of models) {
      Object.defineProperty(model, relationName, {
        value: grouped.get(model.id),
        enumerable: true,
        configurable: true,
      })
    }
  }
}

export function relationsPlugin(): CtroDBPlugin {
  return {
    name: "relations",
    version: "1.0.0",

    onDatabaseInit(db: Database) {
      const engine = new RelationsEngine(db)

      db.collection = new Proxy(db.collection, {
        apply(target, thisArg, args: Parameters<Database["collection"]>) {
          const col = Reflect.apply(target, thisArg, args)
          const queryWith = (...relations: string[]) => {
            const qb = (col as Collection<any>).query()
            const origFetch = qb.fetch.bind(qb)
            qb.fetch = async () => {
              const models = await origFetch()
              await engine.eagerLoad(models as any, (col as Collection<any>).name, relations)
              return models
            }
            return qb
          }
          ;(col as any).with = queryWith
          return col
        },
      })
    },

    onCollectionInit(_collection: unknown) {},
  }
}
