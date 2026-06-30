import type { Database } from "../database"
import type { CtroDBPlugin, ID } from "../types"
import { ChangeTracker, SYNC_STORE } from "./change-tracker"
import { SyncEngine } from "./sync-engine"
import type { SyncPluginConfig } from "./types"

export function syncPlugin(
  config: SyncPluginConfig,
): CtroDBPlugin & { _engine?: SyncEngine } {
  let tracker: ChangeTracker
  let engine: SyncEngine

  const plugin: CtroDBPlugin & { _engine?: SyncEngine } = {
    name: "sync",
    version: "1.0.0",
    storeNames: [SYNC_STORE],

    async onDatabaseInit(db: Database) {
      tracker = new ChangeTracker(db._getAdapter())
      engine = new SyncEngine(db, config)
      plugin._engine = engine
      await engine.init()
    },

    onCollectionInit() {
      // Collections register at runtime. The sync engine applies
      // the collections filter (SyncPluginConfig.collections) at sync time.
    },

    async onAfterCreate(_collection: string, record: unknown) {
      const r = record as Record<string, unknown>
      await tracker.append("create", _collection, r.id as ID, r)
    },

    async onAfterUpdate(
      _collection: string,
      _id: ID,
      record: unknown,
      oldRecord?: unknown,
    ) {
      const r = record as Record<string, unknown>
      const old = oldRecord as Record<string, unknown> | undefined
      await tracker.append("update", _collection, _id, r, old ?? null)
    },

    async onAfterDelete(_collection: string, _id: ID, oldRecord?: unknown) {
      const old = oldRecord as Record<string, unknown> | undefined
      await tracker.append("delete", _collection, _id, null, old ?? null)
    },
  }

  return plugin
}
