# Issue 1: FTS Plugin Crashes on Schema Version Bump

**Severity:** CRITICAL
**File(s):** `src/adapter/idb.ts`, `src/database.ts`, `src/types.ts`, `src/plugins/fts/index.ts`
**Status:** Planned

## Problem

When `indexedDB.open(dbName, version)` is called with a higher version, IndexedDB fires `onupgradeneeded`. The `createMigrationHandler` in `src/adapter/idb.ts` creates object stores for each collection in the schema — but only for stores listed in the schema. The FTS plugin stores its data in `_ctrodb_fts` (see `src/plugins/fts/indexer.ts:4`), which is NOT part of the schema config.

IndexedDB silently drops any existing object store NOT listed in `onupgradeneeded`. After a schema version bump, `_ctrodb_fts` no longer exists, causing every FTS operation to fail with `"Object store '_ctrodb_fts' not found"`.

## Fix Strategy (Option A from audit — recommended)

Pass plugin store names to `createMigrationHandler` so it can create them during `onupgradeneeded`.

### Changes

1. **`src/types.ts`** — Add optional `storeNames?: string[]` to `CtroDBPlugin` interface so plugins can declare the IndexedDB stores they need.

2. **`src/adapter/idb.ts`** — Update `createMigrationHandler` signature to accept `pluginStoreNames: string[]`. Loop over them after schema stores and create any that don't exist.

3. **`src/database.ts`** — In `connect()`, collect plugin store names from plugins (check for `storeNames` property on each plugin). Pass them to `adapter.connect()` alongside the schema config. Extend the schema config passed to the adapter to include plugin stores.

4. **`src/plugins/fts/index.ts`** — Add `storeNames: ["_ctrodb_fts"]` to the plugin object so the migration handler knows about it.

### Key considerations

- The `_ctrodb_meta` store handling (already in `createMigrationHandler`) stays as-is.
- Plugin stores are created with a standard `{ keyPath: "id" }` config — no indexes needed for `_ctrodb_fts` since it uses `findById` with composed keys.
- The adapter's `connect()` signature already accepts `schema: SchemaConfig | null` — we need to extend this or add a separate param for plugin stores.

### Verification

- Schema migration tests: define schema v1 with FTS, create records, bump to v2, verify reads/writes still work
- FTS search still returns correct results after migration
- New schema without FTS: no `_ctrodb_fts` store is created
