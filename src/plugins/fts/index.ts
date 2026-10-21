import type { Collection } from "../../collection"
import type { Database } from "../../database"
import type { CtroDBPlugin, ID } from "../../types"
import { FTSIndexer } from "./indexer"

export function ftsPlugin(): CtroDBPlugin {
  let indexer: FTSIndexer
  const searchableFieldsMap = new Map<string, string[]>()

  return {
    name: "fts",
    version: "1.0.0",
    storeNames: ["_ctrodb_fts"],

    onDatabaseInit(db: Database) {
      indexer = new FTSIndexer(db._getAdapter())
    },

    onCollectionInit(collection: Collection<Record<string, unknown>>) {
      const schema = collection._getSchema()
      const fields = schema?.getSearchableFields(collection.name)
      if (fields && fields.length > 0) {
        searchableFieldsMap.set(collection.name, fields)
      }
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
