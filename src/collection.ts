import { RecordNotFoundError } from "./errors"
import type { ModelInstance } from "./model/index"
import { Model } from "./model/index"
import { QueryBuilder } from "./query/builder"
import type { QueryExecutor, TokenSearch } from "./query/executor"
import type { QueryPlanner } from "./query/planner"
import { Signal } from "./reactive/signal"
import type { Schema } from "./schema"
import type { RelationShapes } from "./schema-types"
import type {
  ChangeEvent,
  CtroDBPlugin,
  ID,
  RelationDefinition,
  StorageAdapter,
  WriteContext,
} from "./types"
import { runAfterHook, runHook } from "./utils/plugin-hooks"
import { LOCAL_WRITE } from "./write-context"

interface DatabaseShim {
  readonly name: string
  _getSchema(): Schema | null
  _emit(event: ChangeEvent): void
  collection(name: string): unknown
  /** Token index supplied by a plugin, if one is installed. */
  _queryTokens?(collection: string, query: string, fields?: string[]): Promise<ID[] | undefined>
}

export class Collection<T extends object, R extends RelationShapes = Record<never, never>> {
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

  /**
   * Insert a record.
   *
   * `context` is internal plumbing: the sync engine passes a remote write
   * context so plugins can distinguish applied server data from local intent.
   */
  async create(
    data: Omit<T, "id"> & { id?: ID },
    context: WriteContext = LOCAL_WRITE,
  ): Promise<ModelInstance<T, R>> {
    const raw = { ...data } as Record<string, unknown>
    if (raw.id === undefined) {
      raw.id = this.#generateId()
    }

    let processed: Record<string, unknown> = raw

    if (this.#schema) {
      processed = this.#schema.applyDefaults(this.name, processed)
      this.#schema.validate(this.name, processed)
    }

    processed = (await runHook(
      this.#plugins,
      "onBeforeCreate",
      this.name,
      processed,
      context,
    )) as Record<string, unknown>

    let record: T
    try {
      record = (await this.#adapter.create(this.name, processed)) as T
    } catch (error) {
      // Normalise adapter-specific failures (IndexedDB throws ConstraintError,
      // the memory adapter throws its own message) so callers can rely on one
      // contract no matter which adapter is in use (audit H-06).
      const message = error instanceof Error ? error.message : String(error)
      const isDuplicate =
        (error instanceof Error && error.name === "ConstraintError") ||
        /already exists|unique constraint/i.test(message)

      if (isDuplicate) {
        // Distinguish the two constraint families, because they need different
        // fixes in application code. The extra read only happens on failure.
        const idTaken = (await this.#adapter.findById(this.name, processed.id as ID)) !== undefined
        const normalized = new Error(
          idTaken
            ? `Record "${String(processed.id)}" already exists in "${this.name}"`
            : `Unique constraint failed in "${this.name}": ${message}`,
        )
        normalized.cause = error
        throw normalized
      }
      throw error
    }
    const model = this._toModel(record)

    await runAfterHook(this.#plugins, "onAfterCreate", [this.name, record, context])

    const event: ChangeEvent = {
      type: "create",
      collection: this.name,
      recordId: (record as Record<string, unknown>).id as ID,
      record,
    }
    this.#changeSignal.value = event
    this.#db._emit(event)

    return model
  }

  /**
   * Insert many records as one operation.
   *
   * Batch inserts exist because the per-record path is dominated by per-record
   * overhead, not by the data: on IndexedDB every `create()` opens its own
   * transaction, and every indexed document costs one index write per token.
   * `createMany()` validates the whole batch first, writes it in a single
   * adapter operation (one transaction where the adapter supports it), then
   * emits one `create` event per record — so listeners, hooks and React state
   * see exactly what they would have seen from N `create()` calls.
   *
   * All-or-nothing: if validation fails or any record violates a constraint,
   * nothing is written. A batch containing a duplicate id is rejected before
   * the adapter is touched.
   */
  async createMany(
    records: readonly (Omit<T, "id"> & { id?: ID })[],
    context: WriteContext = LOCAL_WRITE,
  ): Promise<ModelInstance<T, R>[]> {
    if (records.length === 0) return []

    // Pass 1 — ids, defaults and validation for the whole batch. Doing this
    // before any hook runs means a bad record is reported without side effects
    // from the records that happened to be earlier in the array.
    const stamped: Record<string, unknown>[] = []
    const ids = new Set<ID>()

    for (const [index, data] of records.entries()) {
      const raw = { ...data } as Record<string, unknown>
      if (raw.id === undefined) raw.id = this.#generateId()

      const id = raw.id as ID
      if (ids.has(id)) {
        throw new Error(
          `createMany() received the same id twice in "${this.name}": "${String(id)}" (index ${index})`,
        )
      }
      ids.add(id)

      let processed: Record<string, unknown> = raw
      if (this.#schema) {
        processed = this.#schema.applyDefaults(this.name, processed)
        this.#schema.validate(this.name, processed)
      }
      stamped.push(processed)
    }

    // Pass 2 — hooks, in order, exactly as `create()` would run them.
    const prepared: Record<string, unknown>[] = []
    for (const processed of stamped) {
      prepared.push(
        (await runHook(this.#plugins, "onBeforeCreate", this.name, processed, context)) as Record<
          string,
          unknown
        >,
      )
    }

    let written: T[]
    try {
      written = this.#adapter.createMany
        ? ((await this.#adapter.createMany(this.name, prepared)) as T[])
        : await this.#writeSequentially(prepared)
    } catch (error) {
      throw await this.#normalizeCreateError(error, prepared)
    }

    // Per plugin: a plugin that can index a batch gets one call, everything else
    // keeps its per-record hook. Dispatching per plugin (rather than globally)
    // is what keeps a batching plugin and a simple one correct in the same app.
    for (const plugin of this.#plugins) {
      if (typeof plugin.onAfterCreateMany === "function") {
        await runAfterHook([plugin], "onAfterCreateMany", [this.name, written, context])
      } else {
        for (const record of written) {
          await runAfterHook([plugin], "onAfterCreate", [this.name, record, context])
        }
      }
    }

    const models = written.map((record) => this._toModel(record))

    for (const record of written) {
      const event: ChangeEvent = {
        type: "create",
        collection: this.name,
        recordId: (record as Record<string, unknown>).id as ID,
        record,
      }
      this.#changeSignal.value = event
      this.#db._emit(event)
    }

    return models
  }

  /**
   * Fallback for adapters without `createMany`.
   *
   * Not atomic — an adapter that cannot batch cannot roll back either — so a
   * failure leaves the records written so far in place. Documented, and only
   * reachable for third-party adapters: both shipped adapters implement it.
   */
  async #writeSequentially(prepared: Record<string, unknown>[]): Promise<T[]> {
    const written: T[] = []
    for (const record of prepared) {
      written.push((await this.#adapter.create(this.name, record)) as T)
    }
    return written
  }

  /** Same contract as `create()`, for a whole batch. */
  async #normalizeCreateError(error: unknown, prepared: Record<string, unknown>[]): Promise<Error> {
    const message = error instanceof Error ? error.message : String(error)
    const isDuplicate =
      (error instanceof Error && error.name === "ConstraintError") ||
      /already exists|unique constraint/i.test(message)

    if (!isDuplicate) return error instanceof Error ? error : new Error(message)

    // Which record was already there? Asking is only worth it on failure, and
    // it turns a driver-specific message into an actionable one.
    const ids = prepared.map((record) => record.id as ID)
    const existing = this.#adapter.findByIds
      ? await this.#adapter.findByIds(this.name, ids)
      : await Promise.all(ids.map((id) => this.#adapter.findById(this.name, id)))

    const takenIndex = existing.findIndex((record) => record !== undefined)
    const normalized = new Error(
      takenIndex >= 0
        ? `Record "${String(ids[takenIndex])}" already exists in "${this.name}"`
        : `Unique constraint failed in "${this.name}": ${message}`,
    )
    normalized.cause = error
    return normalized
  }

  async get(id: ID): Promise<ModelInstance<T, R> | undefined> {
    const record = (await this.#adapter.findById(this.name, id)) as T | undefined
    if (!record) return undefined
    return this._toModel(record)
  }

  async getAll(): Promise<ModelInstance<T, R>[]> {
    const records = (await this.#adapter.findAll(this.name)) as T[]
    return this._toModels(records)
  }

  async update(
    id: ID,
    changes: Partial<T>,
    context: WriteContext = LOCAL_WRITE,
  ): Promise<ModelInstance<T, R>> {
    const existing = (await this.#adapter.findById(this.name, id)) as T | undefined
    if (!existing) throw new RecordNotFoundError(this.name, id)

    const processed = (await runHook(
      this.#plugins,
      "onBeforeUpdate",
      this.name,
      id,
      {
        ...changes,
      },
      context,
    )) as Record<string, unknown>

    if (this.#schema) {
      this.#schema.validate(this.name, { ...existing, ...processed })
    }

    const updated = (await this.#adapter.update(this.name, id, processed)) as T
    const model = this._toModel(updated)

    await runAfterHook(this.#plugins, "onAfterUpdate", [this.name, id, updated, existing, context])

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

  async delete(id: ID, context: WriteContext = LOCAL_WRITE): Promise<void> {
    const existing = (await this.#adapter.findById(this.name, id)) as T | undefined

    await runHook(this.#plugins, "onBeforeDelete", this.name, id, context)

    await this.#adapter.delete(this.name, id)

    await runAfterHook(this.#plugins, "onAfterDelete", [this.name, id, existing, context])

    const event: ChangeEvent = {
      type: "delete",
      collection: this.name,
      recordId: id,
      oldRecord: existing,
    }
    this.#changeSignal.value = event
    this.#db._emit(event)
  }

  async deleteMany(ids: ID[], context: WriteContext = LOCAL_WRITE): Promise<void> {
    // One bulk read instead of N sequential ones: on IndexedDB each `findById`
    // is its own transaction, so a 1,000-id delete used to open 1,000 of them
    // just to collect the `oldRecord` its events report.
    const existingMap = new Map<ID, T>()
    const previous = this.#adapter.findByIds
      ? ((await this.#adapter.findByIds(this.name, ids)) as (T | undefined)[])
      : await Promise.all(
          ids.map((id) => this.#adapter.findById(this.name, id) as Promise<T | undefined>),
        )

    for (const [index, id] of ids.entries()) {
      const record = previous[index]
      if (record) existingMap.set(id, record)
      await runHook(this.#plugins, "onBeforeDelete", this.name, id, context)
    }

    await this.#adapter.deleteMany(this.name, ids)

    for (const id of ids) {
      const existing = existingMap.get(id)
      await runAfterHook(this.#plugins, "onAfterDelete", [this.name, id, existing, context])

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

  async put(
    data: T & { id?: ID },
    context: WriteContext = LOCAL_WRITE,
  ): Promise<ModelInstance<T, R>> {
    if (data.id !== undefined) {
      const existing = await this.#adapter.findById(this.name, data.id)
      if (existing) {
        return this.update(data.id, data as Partial<T>, context)
      }
    }
    return this.create(data as Omit<T, "id"> & { id?: ID }, context)
  }

  async count(): Promise<number> {
    // Counting must not copy rows: `findAll()` builds a fresh object per record,
    // so `count()` on 10k rows used to allocate 10k objects to read `.length`.
    if (this.#adapter.count) return this.#adapter.count(this.name)
    const all = await this.#adapter.findAll(this.name)
    return all.length
  }

  query(): QueryBuilder<T, R> {
    return new QueryBuilder<T, R>(this.#getQueryableCollection(), this.#planner, this.#executor)
  }

  with(...relations: string[]): QueryBuilder<T, R> {
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

  _toModel(data: T): ModelInstance<T, R> {
    const model = new Model<T, R>(
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
    return model as unknown as ModelInstance<T, R>
  }

  _toModels(data: T[]): ModelInstance<T, R>[] {
    return data.map((d) => this._toModel(d))
  }

  _getSchema(): Schema | null {
    return this.#schema
  }

  _getAdapter(): StorageAdapter {
    return this.#adapter
  }

  /**
   * The token index for this collection, if a plugin provides one.
   *
   * Returns `undefined` when nothing can answer token queries, which makes
   * `match()` fall back to scanning — same results, slower.
   */
  _queryTokens(): TokenSearch | undefined {
    const lookup = this.#db._queryTokens
    if (!lookup) return undefined
    return (collection, query, fields) => lookup.call(this.#db, collection, query, fields)
  }

  async #eagerLoad(models: Array<ModelInstance<T, R>>, relations: string[]): Promise<void> {
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
    models: Array<ModelInstance<T, R>>,
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
    models: Array<ModelInstance<T, R>>,
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
    models: Array<ModelInstance<T, R>>,
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
      count: () => this.count(),
      _queryTokens: () => this._queryTokens(),
    }
  }
}
