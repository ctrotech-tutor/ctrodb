# Changelog

All notable changes to ctrodb will be documented in this file.

## [1.5.0] - 2026-10-21

Sync pull is now a safe, observable write path, and the core no longer depends on
browser storage globals. Both changes were driven by the Phase 1 audit
(`docs/audit/phase-1-audit.md`); see the finding IDs below.

### Fixed
- **Sync pull no longer overwrites newer local edits (C-01).** A queued local
  change is only superseded when the remote change is newer (ties go to the
  remote, matching the LWW resolver); otherwise the remote snapshot is treated
  as a replay and skipped. The queue is snapshotted before the push phase, so a
  stale server echo cannot roll back data this client just pushed.
- **Applied remote changes are real writes (H-14).** Pull now goes through
  `Collection`, so schema validation, plugin hooks, full-text indexing and
  change events all run. Reactive queries (`useQuery`, `db.on`) update for
  synced data, and records that fail validation abort the pull with an `error`
  event instead of being stored.
- **Unacknowledged pushes are rolled back to `pending`.** Changes can no longer
  be stranded in `syncing` when a transport omits them from its response.
- **Indexed queries and the sync engine work on Node (H-01, H-02).** The query
  planner and change tracker no longer call `IDBKeyRange`; ranges are described
  with a storage-neutral `QueryRange` and only the IndexedDB adapter converts
  them.
- **`!=` on an indexed field returned incorrect rows (H-07).** Non-contiguous
  and non-key conditions now fall back to a scan, so the presence of an index
  can never change a result set.
- **Indexed boolean/object fields threw `DataError`.** Such fields are excluded
  from index-driven scans on both adapters.
- **`VERSION` now matches `package.json` (L-01).** It is injected at build time
  from the manifest; it previously reported `1.3.0` while the package was
  `1.4.0`.

### Added
- `QueryRange`, `QueryKey`, `WriteContext` and `WriteOrigin` public types.
- `createQueryRange`, `equalityRange`, `queryRangeContains`, `compareQueryKeys`
  and `isQueryKey` exported helpers for adapter authors.
- Plugin hooks receive a trailing `context: { origin: "local" | "remote" }`
  argument (backward compatible — existing hooks ignore it).
- Two Vitest projects: `unit` (with `fake-indexeddb`) and `node-pure` (no
  browser storage globals), which is what catches regressions of the Node
  failures above.
- `npm run typecheck:tests`, `npm run verify`, and `tsconfig.tests.json`.
- `react` is declared as an optional peer dependency.

### Changed
- `Collection.create/update/delete/deleteMany/put` accept an optional internal
  `WriteContext` argument. Public call signatures are unchanged.
- `StorageAdapter.scanIndex` and `QueryPlan.range` are typed with `QueryRange`
  instead of `IDBKeyRange` (`QueryRange` is structurally compatible with the
  bound properties of `IDBKeyRange`).

## [1.4.0] - 2026-06-30

### Added
- `PluginStoreConfig` type system — plugins can now declare indexes on their object stores
- IDB migration handler creates `status` + `timestamp` indexes on `_ctrodb_sync_changes` store
- `PluginStoreName` union type (`string | PluginStoreConfig`) for backward-compatible store configs

### Changed
- `ChangeTracker.getPending()` now uses `adapter.scanIndex()` for pending + failed queries in parallel
- `ChangeTracker.countByStatus()`, `countPending()`, `removeCommitted()`, `getFailed()` use
  `scanIndex()` instead of loading the entire queue via `findAll()` + JS filter
- `inspectSyncQueue()` performs 4 parallel `scanIndex` calls (one per status) instead of `findAll` + 4 filters
- `compactSyncQueue()` uses parallel `scanIndex` for pending + failed records only
- Only changes with "syncing" status are loaded during `init()`, not the full queue

### Performance
- Queue queries now load only status-filtered records via IDB native indexes (typically <10% of total queue)
- `removeCommitted()` loads only committed records instead of the entire queue
- `countByStatus()` increments via index-based queries instead of full table scan

## [1.3.1] - 2026-06-30

### Fixed
- Biome lint errors across 16 files (noExplicitAny, noBannedTypes, noUselessThisAlias,
  useExponentiationOperator, useExhaustiveDependencies, useButtonType)
- TypeScript DTS build failure from Collection<T> invariance in #collections map

## [1.0.0] - 2026-06-17

### Added
- React bindings: `useQuery`, `useDoc`, `useMutation`, `DatabaseProvider`, `useDatabase`
- Multi-entry build: `ctrodb/react` subpath export (ESM + CJS + types)
- CDN/IIFE verification — 25.4 KB minified global build
- FTS Plugin: tokenizer, inverted index, lifecycle hooks for index maintenance
- Relations Plugin: RelationsEngine with eager loading (belongs_to, has_many, has_one)
- Validation Plugin: ValidationEngine with custom rules, built-in email/URL/empty-string validators

### Changed
- Bumped to stable v1.0.0 release
- Collection now runs plugin lifecycle hooks (before/after create, update, delete)
- QueryExecutor now applies basic text search filtering (case-insensitive `includes`)
- MemoryAdapter `create()` respects custom `data.id` for FTS index records
- ConnectionError usage fixed in Database class

## [1.0.0-alpha.5] - 2026-06-17

### Added
- Database class: high-level entry point with connect/disconnect, change events, transaction support
- Collection class: CRUD operations (create, get, getAll, update, delete, deleteMany, put, count),
  query builder access, change event subscription
- Model integration with Collection — Proxy-based transparent data access, relation getters

## [1.0.0-alpha.4] - 2026-06-17

### Added
- IndexedDBAdapter: full CRUD via stored procedures, metadata store, shared-transaction rollback
  with stored-procedure-based query execution, schema migration via `onupgradeneeded`
- `createAdapter` factory with auto-detect based on environment
- 33 adapter tests covering Memory and IndexedDB adapters

### Fixed
- Query planner generates `IDBKeyRange.only(value)` for equality operators
- Transaction rollback via snapshot/restore in MemoryAdapter

## [1.0.0-alpha.3] - 2026-06-17

### Added
- QueryPlanner with full_scan/index_scan/id_lookup strategies, OR grouping, index priority selection
- QueryExecutor with filter/sort/limit/offset/OR merge+dedup
- QueryBuilder with fluent API (where/orWhere/sort/limit/offset/search, fetch/first/count/toArray)
- 30 query engine tests

## [1.0.0-alpha.2] - 2026-06-17

### Added
- Schema class: config validation, field defaults, type/format validation, index/relation accessors
- Model class: Proxy-based transparent data access, CRUD delegation, relation getter attachment
- 28 schema + model tests

## [1.0.0-alpha.1] - 2026-06-17

### Added
- Initial workspace setup (TypeScript, tsup, Vitest, Biome)
- Core types: ID, SchemaConfig, QueryCondition, QueryPlan, StorageAdapter, ChangeEvent, CtroDBPlugin
- Error classes: ConnectionError, SchemaError, ValidationError, QueryError, etc.
- Signal\<T\> reactivity system
- MemoryAdapter with Map-based storage, IDBKeyRange-aware scanIndex, snapshot transactions
- 8 signal + 21 schema + 7 model + 30 query + 33 adapter tests (99 total)
- README, LICENSE (MIT), CONTRIBUTING.md, SECURITY.md
- GitHub repo setup with topics and website URL
