import { Model } from "./model/index"
import { QueryBuilder } from "./query/builder"
import type { QueryExecutor } from "./query/executor"
import type { QueryPlanner } from "./query/planner"
import { Signal } from "./reactive/signal"
import type { Schema } from "./schema"
import type { ChangeEvent, CtroDBPlugin, ID, RelationDefinition, StorageAdapter } from "./types"
import { runHook } from "./utils/plugin-hooks"

interface DatabaseShim {
  readonly name: string
  _getSchema(): Schema | null
  _emit(event: ChangeEvent): void
  collection(name: string): unknown
}

export class Collection<T extends Record<string, unknown>> {
  readonly name: string

  #db: DatabaseShim
  #adapter: StorageAdapter
  #schema: Schema | null
  #planner: QueryPlanner
  #executor: QueryExecutor
  #plugins: CtroDBPlugin[]
  #changeSignal = new Signal<ChangeEvent | null>(null)

  constructor(
    name: string,
    db: DatabaseShim,
    adapter: StorageAdapter,
    schema: Schema | null,
    planner: QueryPlanner,
    executor: QueryExecutor,
    plugins: CtroDBPlugin[] = [],
  ) {
    this.name = name
    this.#db = db
    this.#adapter = adapter
    this.#schema = schema
    this.#planner = planner
    this.#executor = executor
    this.#plugins = plugins
  }

  #generateId(): ID {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID()
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  async create(data: Omit<T, "id"> & { id?: ID }): Promise<Model<T> & T> {
    const raw = { ...data } as Record<string, unknown>
    if (raw.id === undefined) {
      raw.id = this.#generateId()
    }

    let processed: Record<string, unknown> = raw

    if (this.#schema) {
      processed = this.#schema.applyDefaults(this.name, processed)
      this.#schema.validate(this.name, processed)
    }

    processed = (await runHook(this.#plugins, "onBeforeCreate", this.name, processed)) as Record<
      string,
      unknown
    >

    const record = (await this.#adapter.create(this.name, processed)) as T
    const model = this._toModel(record)

    await runHook(this.#plugins, "onAfterCreate", this.name, record)

    const event: ChangeEvent = {
      type: "create",
      collection: this.name,
      recordId: record.id as ID,
      record,
    }
    this.#changeSignal.value = event
    this.#db._emit(event)

    return model
  }

  async get(id: ID): Promise<(Model<T> & T) | undefined> {
    const record = (await this.#adapter.findById(this.name, id)) as T | undefined
    if (!record) return undefined
    return this._toModel(record)
  }

  async getAll(): Promise<(Model<T> & T)[]> {
    const records = (await this.#adapter.findAll(this.name)) as T[]
    return this._toModels(records)
  }

  async update(id: ID, changes: Partial<T>): Promise<Model<T> & T> {
    const existing = (await this.#adapter.findById(this.name, id)) as T | undefined
    if (!existing) throw new Error(`Record "${id}" not found in collection "${this.name}"`)

    const processed = (await runHook(this.#plugins, "onBeforeUpdate", this.name, id, {
      ...changes,
    })) as Record<string, unknown>

    if (this.#schema) {
      this.#schema.validate(this.name, { ...existing, ...processed })
    }

    const updated = (await this.#adapter.update(this.name, id, processed)) as T
    const model = this._toModel(updated)

    await runHook(this.#plugins, "onAfterUpdate", this.name, id, updated, existing)

    const event: ChangeEvent = {
      type: "update",
      collection: this.name,
      recordId: id,
      record: updated,
      oldRecord: existing,
    }
    this.#changeSignal.value = event
    this.#db._emit(event)

    return model
  }

  async delete(id: ID): Promise<void> {
    const existing = (await this.#adapter.findById(this.name, id)) as T | undefined

    await runHook(this.#plugins, "onBeforeDelete", this.name, id)

    await this.#adapter.delete(this.name, id)

    await runHook(this.#plugins, "onAfterDelete", this.name, id, existing)

    const event: ChangeEvent = {
      type: "delete",
      collection: this.name,
      recordId: id,
      oldRecord: existing,
    }
    this.#changeSignal.value = event
    this.#db._emit(event)
  }

  async deleteMany(ids: ID[]): Promise<void> {
    const existingMap = new Map<ID, T>()
    for (const id of ids) {
      const record = (await this.#adapter.findById(this.name, id)) as T | undefined
      if (record) existingMap.set(id, record)
      await runHook(this.#plugins, "onBeforeDelete", this.name, id)
    }

    await this.#adapter.deleteMany(this.name, ids)

    for (const id of ids) {
      const existing = existingMap.get(id)
      await runHook(this.#plugins, "onAfterDelete", this.name, id, existing)

      const event: ChangeEvent = {
        type: "delete",
        collection: this.name,
        recordId: id,
        oldRecord: existing,
      }
      this.#changeSignal.value = event
      this.#db._emit(event)
    }
  }

  async put(data: T & { id?: ID }): Promise<Model<T> & T> {
    if (data.id !== undefined) {
      const existing = await this.#adapter.findById(this.name, data.id)
      if (existing) {
        return this.update(data.id, data as Partial<T>)
      }
    }
    return this.create(data as Omit<T, "id"> & { id?: ID })
  }

  async count(): Promise<number> {
    const all = await this.#adapter.findAll(this.name)
    return all.length
  }

  query(): QueryBuilder<T> {
    return new QueryBuilder<T>(this.#getQueryableCollection(), this.#planner, this.#executor)
  }

  with(...relations: string[]): QueryBuilder<T> {
    const qb = this.query()
    const origFetch = qb.fetch.bind(qb)

    qb.fetch = async () => {
      const models = await origFetch()
      await this.#eagerLoad(models, relations)
      return models
    }
    return qb
  }

  onChange(callback: (event: ChangeEvent) => void): () => void {
    return this.#changeSignal.subscribe((event) => {
      if (event) callback(event)
    })
  }

  _toModel(data: T): Model<T> & T {
    const model = new Model<T>(
      data,
      {
        name: this.name,
        update: async (id: ID, changes: Partial<T>) => this.update(id, changes),
        delete: async (id: ID) => this.delete(id),
        _getSchema: () => this.#schema,
      },
      {
        collection: (name: string) => this.#db.collection(name),
      },
      this.#schema,
    )
    return model as unknown as Model<T> & T
  }

  _toModels(data: T[]): (Model<T> & T)[] {
    return data.map((d) => this._toModel(d))
  }

  _getSchema(): Schema | null {
    return this.#schema
  }

  _getAdapter(): StorageAdapter {
    return this.#adapter
  }

  async #eagerLoad(models: Array<Model<T> & T>, relations: string[]): Promise<void> {
    if (models.length === 0 || !this.#schema) return
    for (const relationName of relations) {
      const def = this.#schema.getRelations(this.name)?.[relationName]
      if (!def) continue
      switch (def.type) {
        case "belongs_to":
          await this.#eagerLoadBelongsTo(models, relationName, def)
          break
        case "has_many":
          await this.#eagerLoadHasMany(models, relationName, def)
          break
        case "has_one":
          await this.#eagerLoadHasOne(models, relationName, def)
          break
      }
    }
  }

  async #eagerLoadBelongsTo(
    models: Array<Model<T> & T>,
    relationName: string,
    def: RelationDefinition,
  ): Promise<void> {
    const fks = models
      .map((m) => (m as Record<string, unknown>)[def.foreignKey] as ID | undefined)
      .filter((id): id is ID => id != null)
    if (fks.length === 0) return
    const all = await (
      this.#db.collection(def.collection) as Collection<Record<string, unknown>>
    ).getAll()
    const map = new Map(all.map((r) => [r.id, r]))
    for (const model of models) {
      const fk = (model as Record<string, unknown>)[def.foreignKey] as ID | undefined
      if (fk !== undefined) {
        Object.defineProperty(model, relationName, {
          value: map.get(fk),
          enumerable: true,
          configurable: true,
        })
      }
    }
  }

  async #eagerLoadHasMany(
    models: Array<Model<T> & T>,
    relationName: string,
    def: RelationDefinition,
  ): Promise<void> {
    const ids = models.map((m) => m.id).filter((id): id is ID => id != null)
    if (ids.length === 0) return
    const all = await (
      this.#db.collection(def.collection) as Collection<Record<string, unknown>>
    ).getAll()
    const grouped = new Map<ID, typeof all>()
    for (const r of all) {
      const fk = (r as Record<string, unknown>)[def.foreignKey] as ID | undefined
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

  async #eagerLoadHasOne(
    models: Array<Model<T> & T>,
    relationName: string,
    def: RelationDefinition,
  ): Promise<void> {
    const ids = models.map((m) => m.id).filter((id): id is ID => id != null)
    if (ids.length === 0) return
    const all = await (
      this.#db.collection(def.collection) as Collection<Record<string, unknown>>
    ).getAll()
    const grouped = new Map<ID, (typeof all)[0]>()
    for (const r of all) {
      const fk = (r as Record<string, unknown>)[def.foreignKey] as ID | undefined
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

  #getQueryableCollection() {
    return {
      name: this.name,
      _getSchema: () => this.#schema,
      _getAdapter: () => this.#adapter,
      _toModels: (raw: T[]) => this._toModels(raw),
    }
  }
}
