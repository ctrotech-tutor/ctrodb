import type { Collection } from "../../collection"
import type { Database } from "../../database"
import type { CtroDBPlugin, ID } from "../../types"
import { FTS_FORMAT, FTS_INDEXED_FIELDS, FTS_STORE, FTSIndexer } from "./indexer"

/** Where the index format version is persisted (`StorageAdapter.getMetadata`). */
const FORMAT_KEY = "_ctrodb_fts_format"

export function ftsPlugin(): CtroDBPlugin {
  let indexer: FTSIndexer
  let database: Database | undefined
  const searchableFieldsMap = new Map<string, string[]>()

  /**
   * Upgrade a legacy index (format 1) in place.
   *
   * Format 1 records cannot be read by the posting store — they are a different
   * shape entirely — so they are dropped and rebuilt from the collections. The
   * index is derived data, so rebuilding is always safe; doing it once at
   * connect keeps search results complete across the upgrade.
   */
  async function migrate(): Promise<void> {
    const adapter = database?._getAdapter()
    if (!adapter) return

    const stored = await adapter.getMetadata(FORMAT_KEY)
    if (Number(stored) >= FTS_FORMAT) return

    // The stamp is absent on a fresh store *and* on a database that was written
    // before this plugin existed. Both need the index built from the rows, so
    // rebuild whenever the stamp is not current.
    await indexer.clear()
    await rebuild()

    await adapter.setMetadata(FORMAT_KEY, FTS_FORMAT)
  }

  /** Re-index every searchable collection from its rows. */
  async function rebuild(): Promise<void> {
    const schema = database?._getSchema()
    const adapter = database?._getAdapter()
    if (!schema || !adapter) return

    for (const collectionName of Object.keys(schema.collections)) {
      const fields = schema.getSearchableFields(collectionName)
      if (!fields || fields.length === 0) continue

      const records = await adapter.findAll(collectionName)
      for (const record of records) {
        await indexer.indexRecord(collectionName, record as Record<string, unknown>, fields)
      }
    }
  }

  return {
    name: "fts",
    version: "2.0.0",

    // Declaring the indexes is what lets `FTSIndexer.search` answer a token
    // lookup with one index scan instead of reading the whole posting store.
    storeNames: [{ name: FTS_STORE, indexes: FTS_INDEXED_FIELDS.map((field) => ({ field })) }],

    async onDatabaseInit(db: Database) {
      database = db
      indexer = new FTSIndexer(db._getAdapter())
      await migrate()
    },

    onCollectionInit(collection: Collection<Record<string, unknown>>) {
      const schema = collection._getSchema()
      const fields = schema?.getSearchableFields(collection.name)
      if (fields && fields.length > 0) {
        searchableFieldsMap.set(collection.name, fields)
      }
    },

    /**
     * Answer `query().match()` from the index.
     *
     * Declines (`undefined`) when this plugin does not index the collection, or
     * when the caller asked about fields outside the indexed set — the index is
     * a *superset* of a collection-wide token query but not of a field-specific
     * one, and returning ids there would lose rows.
     */
    async queryTokens(collection: string, query: string, fields?: string[]) {
      if (!indexer) return undefined
      const searchable = searchableFieldsMap.get(collection)
      if (!searchable || searchable.length === 0) return undefined
      if (fields && fields.length > 0 && fields.some((field) => !searchable.includes(field))) {
        return undefined
      }
      return indexer.search(collection, query)
    },

    // These hooks are awaited by the write path. Returning the promise (rather
    // than starting a floating async call) is what keeps an indexing failure
    // observable instead of surfacing as an unhandledRejection.
    async onAfterCreate(_collection: string, record: unknown) {
      const fields = searchableFieldsMap.get(_collection)
      if (!fields) return
      await indexer.indexRecord(_collection, record as Record<string, unknown>, fields)
    },

    async onAfterUpdate(_collection: string, _id: ID, record: unknown, oldRecord?: unknown) {
      const fields = searchableFieldsMap.get(_collection)
      if (!fields || !oldRecord) return
      await indexer.updateRecord(
        _collection,
        oldRecord as Record<string, unknown>,
        record as Record<string, unknown>,
        fields,
      )
    },

    async onAfterDelete(_collection: string, _id: ID, oldRecord?: unknown) {
      const fields = searchableFieldsMap.get(_collection)
      if (!fields || !oldRecord) return
      await indexer.removeRecord(_collection, oldRecord as Record<string, unknown>, fields)
    },
  } as CtroDBPlugin
}
