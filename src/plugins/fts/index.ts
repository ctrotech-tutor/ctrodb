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

    onCollectionInit(collection: Collection<any>) {
      const schema = collection._getSchema()
      const fields = schema?.getSearchableFields(collection.name)
      if (fields && fields.length > 0) {
        searchableFieldsMap.set(collection.name, fields)
      }
    },

    onAfterCreate(_collection: string, record: unknown) {
      const fields = searchableFieldsMap.get(_collection)
      if (fields) {
        indexer.indexRecord(_collection, record as Record<string, unknown>, fields)
      }
    },

    onAfterUpdate(_collection: string, _id: ID, record: unknown, oldRecord?: unknown) {
      const fields = searchableFieldsMap.get(_collection)
      if (fields && oldRecord) {
        indexer.updateRecord(
          _collection,
          oldRecord as Record<string, unknown>,
          record as Record<string, unknown>,
          fields,
        )
      }
    },

    onAfterDelete(_collection: string, _id: ID, oldRecord?: unknown) {
      const fields = searchableFieldsMap.get(_collection)
      if (fields && oldRecord) {
        indexer.removeRecord(_collection, oldRecord as Record<string, unknown>, fields)
      }
    },
  } as CtroDBPlugin
}
