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

- **Duplicate ids and unique indexes behave the same on every adapter (H-06).**
  The memory adapter overwrote an existing record on `create()` while IndexedDB
  threw, and it ignored `unique: true` indexes entirely. Both adapters now
  reject duplicates, and `Collection.create()` normalises the message to
  `Record "<id>" already exists in "<collection>"` /
  `Unique constraint failed in "<collection>"`.
- **A failing "after" hook no longer fails a committed write (H-09).** The
  write is already durable when these hooks run; failures are logged (and
  forwarded to a custom `onError`) instead of rejecting the caller and
  inviting a duplicate retry.
- **FTS indexing failures are no longer unhandled rejections (H-10).** The
  indexing hooks are awaited by the write path instead of firing and
  forgetting.
- **A blocked IndexedDB upgrade rejects instead of hanging forever (H-11).**
  The error explains that another tab holds the database open.
- **Indexes added to the schema are created on upgrade (H-12).** Previously
  they were only created together with a brand-new store, so adding an index
  to an existing collection silently did nothing.
- **`client-wins` no longer drops a change the server rejected (H-15).** It
  stays queued and is retried, and becomes an explicit `failed` entry after 3
  rejected attempts rather than diverging silently.

- **`db.transaction()` is now actually atomic (H-03, H-04, H-05).** It
  resolves only after the IndexedDB transaction has committed, and a callback
  error aborts the transaction and propagates **unchanged** (previously
  `tx.abort()` could throw `InvalidStateError` and mask it). The memory adapter
  exposes the same scoped `ctx.collection()` API instead of returning the raw
  adapter, and rolls back with a per-operation undo journal instead of a
  whole-store snapshot — so a rollback no longer deletes unrelated writes that
  happened while the transaction was in flight.
- **Query results have a defined order (H-08).** Without an explicit `sort()`,
  records come back in primary-key ascending order on every adapter, matching
  IndexedDB. `limit()`/`offset()` therefore return the same window on memory and
  IndexedDB. `orWhere()` queries now honour `sort()`, `offset()` and `limit()`,
  which were previously dropped.

### Added
- `QueryRange`, `QueryKey`, `WriteContext` and `WriteOrigin` public types.
- `TransactionCollection` type: `TransactionContext.collection()` is properly
  typed instead of returning `unknown`.
- `createQueryRange`, `equalityRange`, `queryRangeContains`, `compareQueryKeys`
  and `isQueryKey` exported helpers for adapter authors.
- Plugin hooks receive a trailing `context: { origin: "local" | "remote" }`
  argument (backward compatible — existing hooks ignore it).
- Two Vitest projects: `unit` (with `fake-indexeddb`) and `node-pure` (no
  browser storage globals), which is what catches regressions of the Node
  failures above.
- `npm run typecheck:tests`, `npm run verify`, and `tsconfig.tests.json`.
- `npm run typecheck:smoke` — type-checks a consumer against the *built*
  declarations, which is what catches packaging regressions such as two
  incompatible `Database` types.
- `react` is declared as an optional peer dependency.

### Changed
- `ctrodb/react` now shares one type identity with `ctrodb` (H-13). The React
  declarations import `Database` et al. from the root entry instead of
  redeclaring them, so `DatabaseProvider` accepts any `Database` created
  through the main entry point. Verified by a consumer type-check in CI.
- `Collection.create()` with an id that already exists now rejects on both
  adapters. Previously the memory adapter silently overwrote the record.
- `db.transaction()` is a *context* API: writes go through
  `tx.collection(name)`. Writes made through `db.collection(...)` inside the
  callback are no longer captured by the rollback on the memory adapter (they
  never were on IndexedDB, so the two adapters now agree). See README
  "Transactions".
- Unordered queries on the memory adapter return primary-key order instead of
  insertion order, matching IndexedDB.
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
