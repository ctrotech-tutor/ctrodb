import { RecordNotFoundError } from "./errors"
import type { Schema } from "./schema"
import type {
  ChangeEvent,
  CtroDBPlugin,
  ID,
  TransactionCollection,
  TransactionContext,
  WriteContext,
} from "./types"
import { generateId } from "./utils/id"
import { runAfterHook, runHook } from "./utils/plugin-hooks"
import { LOCAL_WRITE } from "./write-context"

/** A write that committed, remembered so its hooks and events can be replayed. */
type CommittedWrite =
  | { type: "create"; collection: string; record: Record<string, unknown> }
  | {
      type: "update"
      collection: string
      id: ID
      record: Record<string, unknown>
      oldRecord: Record<string, unknown> | undefined
    }
  | {
      type: "delete"
      collection: string
      id: ID
      oldRecord: Record<string, unknown> | undefined
    }

export interface TransactionPipelineDeps {
  readonly schema: Schema | null
  readonly plugins: CtroDBPlugin[]
  emit(event: ChangeEvent): void
  /** Ensure collection plugins have received `onCollectionInit`. */
  initializeCollection?(name: string): void
  /** Write context for every operation in the transaction. */
  readonly context?: WriteContext
}

/**
 * A {@link TransactionContext} that behaves like the `Collection` API.
 *
 * Handing the raw adapter context to callers made `db.transaction()` a hole in
 * the library's contract: writes inside it skipped schema validation, never ran
 * plugin hooks (so a document created in a transaction was missing from the
 * full-text index) and emitted no change events (so `db.on()` and reactive
 * queries ignored it).
 *
 * The fix cannot be "run the after-hooks inside the transaction": a plugin
 * writes through the adapter, which opens its *own* transaction, and awaiting an
 * unrelated transaction inside an IndexedDB one lets the outer transaction
 * auto-commit. So writes are recorded here and replayed **after the commit** —
 * which also gives the right abort semantics: a rolled-back transaction leaves
 * no index entry and no event behind.
 */
export class TransactionPipeline implements TransactionContext {
  readonly #inner: TransactionContext
  readonly #deps: TransactionPipelineDeps
  readonly #writes: CommittedWrite[] = []

  constructor(inner: TransactionContext, deps: TransactionPipelineDeps) {
    this.#inner = inner
    this.#deps = deps
  }

  collection(name: string): TransactionCollection {
    this.#deps.initializeCollection?.(name)
    const inner = this.#inner.collection(name)
    const schema = this.#deps.schema
    const plugins = this.#deps.plugins
    const context = this.#deps.context ?? LOCAL_WRITE
    const writes = this.#writes

    return {
      async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const raw = { ...data }
        if (raw.id === undefined) raw.id = generateId()

        let processed: Record<string, unknown> = raw
        if (schema) {
          processed = schema.applyDefaults(name, processed)
          schema.validate(name, processed)
        }

        // Before-hooks run inside the transaction, exactly as they would for
        // `collection.create()`. The shipped plugins transform data
        // synchronously; a hook that performs non-database async work would
        // hold an IndexedDB transaction open across a task boundary.
        processed = (await runHook(plugins, "onBeforeCreate", name, processed, context)) as Record<
          string,
          unknown
        >

        const created = (await inner.create(processed)) as Record<string, unknown>
        writes.push({ type: "create", collection: name, record: created })
        return created
      },

      findById: (id: ID) => inner.findById(id),

      findAll: () => inner.findAll(),

      async update(id: ID, changes: Record<string, unknown>): Promise<Record<string, unknown>> {
        const existing = (await inner.findById(id)) as Record<string, unknown> | undefined
        if (!existing) throw new RecordNotFoundError(name, id)

        const processed = (await runHook(
          plugins,
          "onBeforeUpdate",
          name,
          id,
          { ...changes },
          context,
        )) as Record<string, unknown>

        if (schema) schema.validate(name, { ...existing, ...processed })

        const updated = (await inner.update(id, processed)) as Record<string, unknown>
        writes.push({ type: "update", collection: name, id, record: updated, oldRecord: existing })
        return updated
      },

      async delete(id: ID): Promise<void> {
        const existing = (await inner.findById(id)) as Record<string, unknown> | undefined
        await runHook(plugins, "onBeforeDelete", name, id, context)
        await inner.delete(id)
        writes.push({ type: "delete", collection: name, id, oldRecord: existing })
      },
    }
  }

  /**
   * Replay the committed writes: plugin after-hooks first (they maintain
   * indexes), then the change events.
   *
   * A hook failure is reported rather than thrown: the data is already durable
   * and rejecting `db.transaction()` would report a successful commit as a
   * failure, inviting a retry that duplicates it. This mirrors `Collection`.
   */
  async flush(): Promise<void> {
    const context = this.#deps.context ?? LOCAL_WRITE

    for (const write of this.#writes) {
      if (write.type === "create") {
        await runAfterHook(this.#deps.plugins, "onAfterCreate", [
          write.collection,
          write.record,
          context,
        ])
        this.#deps.emit({
          type: "create",
          collection: write.collection,
          recordId: write.record.id as ID,
          record: write.record,
        })
        continue
      }

      if (write.type === "update") {
        await runAfterHook(this.#deps.plugins, "onAfterUpdate", [
          write.collection,
          write.id,
          write.record,
          write.oldRecord,
          context,
        ])
        this.#deps.emit({
          type: "update",
          collection: write.collection,
          recordId: write.id,
          record: write.record,
          oldRecord: write.oldRecord,
        })
        continue
      }

      await runAfterHook(this.#deps.plugins, "onAfterDelete", [
        write.collection,
        write.id,
        write.oldRecord,
        context,
      ])
      this.#deps.emit({
        type: "delete",
        collection: write.collection,
        recordId: write.id,
        oldRecord: write.oldRecord,
      })
    }

    this.#writes.length = 0
  }
}
