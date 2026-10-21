# Changelog

All notable changes to ctrodb are documented in this file. Releases are
published automatically from tags by `.github/workflows/publish.yml`.

## [1.9.2] - 2026-10-21

### Fixed
- **The full-text index lost entries, and could fail, when writes overlapped.**
  The index kept one record per token holding a `docIds` array, and every write
  read that array, mutated it and wrote it back. Two writes to the same token
  therefore raced, and the second one's `create` could throw:

  | scenario | before | after |
  |---|---|---|
  | 50 concurrent `create()` calls sharing a token | **1** of 50 indexed | 50 of 50 |
  | 300 concurrent `FTSIndexer.indexRecord()` calls | threw `Record "docs:common" already exists` | no error, 300 of 300 |

  The failure was also silent in the plugin path: the duplicate-key error was
  logged as a plugin failure while `create()` still resolved, so the write
  looked successful and simply was not searchable.

  The index now stores **one record per (collection, token, document) posting**.
  Each posting is an independent insert or delete, so writes do not race, are
  idempotent (re-indexing the same document is a no-op) and never read the
  index before writing to it.

### Performance
The same layout change removes the quadratic cost of maintaining the index —
every write used to copy a posting list that grew with the collection.

| measurement (memory adapter) | before | after |
|---|---|---|
| index 8,000 documents | 3,968 ms (496 µs/doc) | **261 ms** (33 µs/doc) — ~15x |
| per-document cost, 1k → 8k docs | 97 → 496 µs (grows with N) | 48 → 33 µs (flat) |
| `deleteMany` of 4,000 indexed documents | 3,496 ms | **150 ms** — ~23x |
| 5,000 `create()` calls with plugins | 10,150/s | **28,539/s** |
| `delete` with plugins | 500 µs | **32 µs** |

`FTSIndexer.search()` uses a `token` index on the posting store (declared by the
plugin) so a query token is one index scan. An indexer constructed directly over
an adapter connected without a schema falls back to scanning the posting store —
same results, slower.

### Added
- **`StorageAdapter.hasIndex?(collection, indexName)`** — optional, so plugins
  can choose an indexed lookup over a scan. Adapters without it are treated as
  "no index" and take the scan path.
- **`StorageAdapter.findByIds?(collection, ids)`** — optional bulk read, used by
  `Collection.deleteMany()`. It previously read the records one at a time to
  fill in `oldRecord` for its events; on IndexedDB that was one transaction per
  id (1,000 transactions to delete 1,000 rows). Adapters without the method keep
  the per-id loop. Delete events and their `oldRecord` payloads are unchanged.

### Migration
An index written in the previous format is detected at `connect()`, dropped and
rebuilt from the collections (the index is derived data, so this is safe), then
recorded under `_ctrodb_fts_format`. Search results stay complete across the
upgrade.

### Verification
- `tests/integration/fts-index.test.ts` (15 tests, both adapters): concurrent
  writes are all indexed, an insert performs **no** read of the posting store and
  writes exactly one posting per token, update/delete move and remove postings,
  multi-token queries require every token, collections stay separate, re-indexing
  is idempotent, the no-index fallback still searches, and a format-1 store is
  rebuilt on connect.
- `tests/integration/bulk-delete.test.ts` (6 tests, both adapters): one bulk read
  per `deleteMany` and zero per-id reads, unchanged delete events, and the
  fallback for adapters without `findByIds`.
- `npm run perf:guard` now fails if indexing 6,000 documents exceeds 900 ms;
  it measured 257 ms with this change and 2,268 ms before it.
- `npm run verify` — 629 tests / 39 files.

## [1.9.1] - 2026-10-21

### Added
- **`ctrodb/package.json` is reachable.** The `exports` map only declared `.`
  and `./react`, so tools that read package metadata — `npm ls`, bundler
  plugins, licence and SBOM scanners — got
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. Both forms now work:

  ```js
  const meta = require("ctrodb/package.json")            // CJS
  import meta from "ctrodb/package.json" with { type: "json" }  // ESM
  ```

  Additive: no existing import path changes, and `attw` reports all four
  resolution modes green, including the new subpath.

### Changed
- **The release workflow now confirms a version is actually readable.** On
  2026-10-21 `ctrodb@1.9.0` published successfully and the registry kept serving
  1.8.2 for about 35 minutes — indistinguishable from a failed release. The
  publish job now polls `npm view ctrodb@<version>` for up to five minutes and
  emits a warning annotation naming the npm URL if the version is still absent.
  It does not fail the run: replication lag is not a publish failure, but it must
  not be silent.
- `scripts/verify-package.mjs` fails the build if `./package.json` is dropped
  from `exports`, so the subpath cannot silently disappear again.

### Verification
- `npm pack`, install the tarball in a clean project, then `require("ctrodb/package.json")`,
  `import ... with { type: "json" }`, and a CJS runtime smoke test all pass.
- `npx @arethetypeswrong/cli --pack .`: green for `ctrodb`, `ctrodb/react` and
  `ctrodb/package.json` under node10, node16 (CJS), node16 (ESM) and bundler.

## [1.9.0] - 2026-10-21

### Added
- **Typed lazy relation getters.** `model.<relation>` has always returned a
  `QueryBuilder`, and the README documented `await post.author.first()`, but the
  getter was invisible to TypeScript: only `load()` was typed, so the documented
  example did not compile (audit M-13). Models now carry the relation map:

  ```typescript
  const latest = await post.author.sort({ name: "desc" }).first()   // Author | undefined
  const drafts = await author.posts.where("draft", "==", true).fetch() // Post[]
  post.posts        // compile error: not a relation of `posts`
  post.author.posts // compile error: a to-one relation has no collection
  ```

- **`ModelInstance<T, R>`** and **`RelationAccessors<R>`** are exported: the
  full model type the API returns (methods + document fields + relation getters),
  so wrappers and helpers can name it instead of reconstructing the intersection.
- **`useQuery`, `useDoc` and `useMutation` accept the relation map**
  (`useQuery<Post, RelationsOf<TypedSchema, "posts">>`), so hook results expose
  the same typed getters as `collection()` results. Existing calls are
  unaffected: the parameter defaults to no relations.

### Verification
- `scripts/type-smoke/schema-types.ts` asserts the typed getters against the
  **built** declarations, including the two rejected shapes above.
- `tests/integration/schema-types.test.ts` asserts the runtime agrees: the getter
  is a builder that filters, and `author()` resolves the related record.

## [1.8.2] - 2026-10-21

### Performance
- **`count()` no longer materialises the collection.** `Collection.count()` went
  through `findAll()`, which copies every record (`{ ...record }`) only to read
  `.length`, and `QueryBuilder.count()` then wrapped each copy in a `Model`
  Proxy and discarded it. On 10,000 rows, `count()` was **3,386 ops/s**.

  `StorageAdapter` gained an **optional** `count(collection)` capability
  (additive: adapters that do not implement it keep working through
  `findAll()`). The memory adapter answers from `Map.size`, the IndexedDB
  adapter uses `store.count()`, and an unfiltered query count delegates straight
  to the collection. Measured on the same 10,000 rows:

  | call | before | after |
  |---|---|---|
  | `collection.count()` | 3,386 ops/s | **4,357,036 ops/s** (~1,290x) |
  | `query().count()` (unfiltered) | 3,386 ops/s | **2,992,612 ops/s** (~880x) |

  Filtered counts still scan, but no longer construct models for rows they are
  about to throw away: `tests/integration/count.test.ts` asserts `_toModels` is
  never called.

### Verification
- `tests/integration/count.test.ts`: adapter fast path (no `findAll`), filtered
  count, `limit`/`offset`/`sort` still respected, deletes, and an adapter
  without `count()` falling back to the previous behaviour.

## [1.8.1] - 2026-10-21

### Fixed
- **Indexes on the memory adapter now do something.** `scanIndex()` ignored the
  adapter's index structures: it copied the whole collection with `findAll()`
  and filtered it, so a query the planner had routed through an index cost
  *more* than a plain scan. Measured with the repo's benchmark on 10,000 rows:

  | query | before | after |
  |---|---|---|
  | `where("score", "==", 42)` | 1,646 ops/s | **21,371 ops/s** (~13x) |
  | `where("score", ">=", 90)` | 930 ops/s | **1,352 ops/s** (~1.5x) |

  On a 20,000-row collection a selective equality lookup went from 1.47 ms to
  0.008 ms (~190x) because it no longer copies the collection first.

  The adapter now keeps real buckets (field -> encoded key -> ids), maintained on
  `create`, `update`, `delete`, `deleteMany` and transaction rollback, and walks
  distinct keys for range queries instead of records. Values that are not valid
  IndexedDB keys (boolean, `null`, object, array) in an indexed field switch that
  field back to a scan, so rows can never disappear from a result set.

  Writes pay for the maintenance: +12% on a 20,000-row insert with two indexes
  (211 ms -> 236 ms in the same measurement). That is the expected trade for
  turning indexed reads from a regression into a win.

### Verification
- `tests/integration/memory-index.test.ts` covers equality and range results
  against a full scan, bucket moves on update, deletes, `deleteMany`,
  transaction rollback, and the non-indexable fallback.
- One test asserts the behaviour directly: an indexed equality query makes
  **no** `findAll()` call, and the same query on an unindexed field does.

## [1.8.0] - 2026-10-21

Types are now derived from the schema (M-14).

### Added
- **`defineSchema()`** - validates a schema when it is declared (unknown field
  types, indexes or relations pointing at missing fields) and preserves its
  literal field types so the rest of the API can derive from it.
- **`createDatabase()`** - returns a `Database` whose `collection()` is typed
  from the schema, so there are no hand-written document interfaces any more:
  `db.collection("todos")` is `Collection<{ id: ID; text: string; done?: boolean }>`.
- **Typed queries.** `where()` requires a declared field and a value matching
  that field's type, and accepts only the documented operators; `sort()` takes
  declared field names; `search()` accepts string fields only, because searching
  a number or boolean can never match.
- **Typed relations.** `post.load("author")` is `Author | undefined`,
  `author.load("posts")` is `Post[]`, and a name that is not a relation of that
  collection is a compile error.
- **Exported type helpers**: `DocumentOf`, `InferRecord`, `RelationsOf`,
  `CollectionName`, `FieldValue`, `HasManyKeys`, `ToOneKeys`, `RelationShapes`.

### Field typing rules
- `required: true` -> required on the document and in `create()`.
- everything else -> optional (`T | undefined`), including fields with a
  `default`: the default is applied on write, but rows written before it existed
  (or arriving through sync) may not carry the field.
- `array` fields use their `items` definition when present.

### Notes
- `new Database({ schema })` keeps its previous untyped behaviour, so existing
  code is unchanged.
- Collection *names* are not compile-checked on `createDatabase()` results: a
  type-level guarantee there would make the typed database invariant and stop it
  being assignable to `Database`. An undeclared name still throws
  `CollectionNotFoundError` at runtime.

### Verification
`scripts/type-smoke/schema-types.ts` compiles the documented usage against the
**built** declarations (every rejected case is a `@ts-expect-error`, so a type
regression fails the build), and `tests/integration/schema-types.test.ts` checks
the runtime behaviour those types describe.

## [1.7.2] - 2026-10-21

### Fixed
- **Filter semantics are defined in one place (L-08).** The "does this record
  match" predicate existed three times: in the executor (with `search`, and
  `false` for an unrecognised operator) and in both adapters (without `search`,
  and `true` — i.e. *match* — for an unrecognised operator). It now lives in
  `src/query/predicate.ts`; an operator that cannot be evaluated never matches.
- **Queue counts are correct after a failed sync (L-12).** `status.pendingChanges`
  came from a cache that was only refreshed on success, so a failed push left the
  UI reporting "0 pending" while changes were still waiting. Counts are refreshed
  in `finally`.
- **A cancelled request no longer marks the transport offline (L-14).** Any
  error, including a caller's `AbortController`, set the HTTP transport to
  disconnected. Cancellation is now distinguished from a transport failure, and
  the merged timeout signal clears its timer and abort listener when the request
  settles instead of leaking both.
- **Storage exhaustion is a typed error (L-15).** IndexedDB `QuotaExceededError`
  surfaced as a raw `DOMException` from inside the adapter. It is now
  `StorageQuotaError` (exported), so applications can tell "out of space" apart
  from a bug. The original error is kept as `cause`.
- **`db.collection("_create")` no longer bypasses the connection check (L-09).**
  A special case in `Database.collection` let one internal name skip the
  "call `connect()` first" guard.

### Changed
- **Tests and scripts are linted (L-05).** Biome now covers `tests/` and
  `scripts/` with a relaxed rule set for test code (no `!` or `any` rules), so
  dead imports and unused bindings in tests are caught like everywhere else.
- **React test noise removed (L-07).** Two tests let state updates escape `act`,
  producing warnings that can mask real ordering problems.
- **Stale audit document archived (L-10).** The pre-audit `ctrodb.md` report moved
  to `docs/archive/` with a banner; two of its central claims are false and were
  disproved by the Phase 1 audit.
- **Bundle-size claim is measured (L-04).** README states the measured 53 KB
  minified / 16 KB gzipped for the core and 8 KB / 3 KB for `ctrodb/react`.

## [1.7.1] - 2026-10-21

### Fixed
- **Documented React API now compiles (M-19).** The README typed `useSync()` as
  `() => Promise<void>` (it returns `{ sync, status }`), passed a `db` prop to
  `SyncDevPanel` (it reads the database from context), called `useSyncQueue(db)`
  with an argument the hook does not take, documented `error: null` where the
  type is `Error | undefined`, and showed `post.author.first()` as the lazy
  relation API — a property that does not exist on `Model<T>`. All corrected.
- **Interfaces work as document types.** The generic constraint on
  `db.collection<T>()`, `useQuery<T>()`, `useDoc<T>()`, `useMutation<T>()`,
  `Collection<T>`, `QueryBuilder<T>` and `Model<T>` was `Record<string, unknown>`,
  so a plain `interface Todo { id: string; text: string }` — the natural way to
  type records — was rejected with "Index signature for type 'string' is
  missing". The constraint is now `object`; existing code is unaffected.

### Added
- **The docs are type-checked.** `scripts/type-smoke/docs.tsx` compiles the
  README's React, hooks, model and relation examples against the *built*
  declarations in `npm run verify` and CI.
- **`react` is a declared peer dependency** (`>=18`, optional), so package
  managers can flag a missing or duplicated React.

### CI
- Node 22 and 24 are the tested matrix (Node 20 is end-of-life).
- Coverage thresholds are enforced by `npm run test:coverage`.
- `@arethetypeswrong/cli --pack` runs on every push and before publishing.

## [1.7.0] - 2026-10-21

### Changed
- **Direct assignment on a model now throws (M-12).** `todo.text = "x"` used to
  log a warning and return `true`, so the assignment looked successful while the
  stored record kept the old value. It now raises `TypeError` and points at
  `model.update({ text: "x" })`.
- **Models are transparent to ordinary JavaScript (M-12).** Record fields are
  own enumerable properties, so `{ ...todo }`, `Object.keys`, `Object.entries`,
  `"field" in model`, `Object.hasOwn` and `JSON.stringify` all see the data.
  Relation getters stay non-enumerable, so a spread yields exactly the fields.

### Added
- **`model.load(relation)` (M-13).** Relations could be read as a lazy
  `QueryBuilder` or, after `.with()`, as resolved data — the same property with
  two contracts. `load()` resolves relation *data*: an array for `has_many`, a
  single record for `has_one`/`belongs_to`, and rejects unknown names.

### Fixed
- **Cross-tab broadcasts no longer trigger phantom syncs (M-09).** A local write
  posted on a `BroadcastChannel` that the same tab's sync engine listened to, so
  one write produced `push,push,pull` plus an extra network round-trip even with
  `autoSync: false`. Messages now carry an origin id that receivers ignore, one
  channel is shared per context, and `destroy()` releases it.
- **`useQuery` cannot show stale data any more (M-16).** Responses are
  sequenced, caller `deps` are compared instead of being spread into the effect's
  dependency array (React threw when their length changed), change events are
  coalesced over one frame, and background refreshes no longer flip `loading`.

## [1.6.0] - 2026-10-21

### Fixed
- **Schema type checks are real (M-04).** `array` fields reject non-arrays,
  `object` fields reject arrays and `null`, and `NaN` is no longer accepted for
  `number`. Previously every one of these passed because `typeof` reports
  `"object"` for arrays and `null`.
- **Undeclared collections throw (M-05).** `db.collection("typo")` on a database
  with a schema now raises `CollectionNotFoundError` listing the declared
  collections. Before, it created an unvalidated, unindexed collection that
  silently bypassed the schema.
- **Typed errors from the write path (M-06).** Updating a missing record now
  throws the exported `RecordNotFoundError` instead of a bare `Error`, so
  callers can branch on `instanceof` rather than message text.
- **The `collections` sync filter applies to push (M-08).** A plugin configured
  for a subset of collections used to push everything and only filter pulls.
- **Real-time server pushes work (M-11).** The engine subscribes to
  `transport.onServerPush`, triggering a debounced sync, and releases the
  subscription with the engine. Previously the transport exposed the callback
  but nothing ever registered it, so pushed data waited for the next poll.

### Documented
- `query().search(field, text)` is a case-insensitive **substring** filter, not
  an FTS query. Documented explicitly so the behaviour is a contract, not an
  accident (M-15); a future release can route it through the FTS index.

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

- **Schema declarations are enforced (M-02, M-03).** A `validate` function is
  now called, and `unique: true` on a field becomes a unique index so both
  adapters reject duplicates. A field declared unique whose index is not unique
  now fails at schema construction instead of being silently ignored.
- **`retryMaxAttempts` works (M-07).** Changes that fail that many times are
  parked as dead letters (visible in `inspectSyncQueue().failed`, retryable
  with `retryFailedSync`) instead of retrying forever.
- **`db.disconnect()` shuts plugins down (M-10).** Plugins receive a new
  `onDatabaseDestroy` hook in reverse order; the sync engine's auto-sync
  interval, backoff/debounce timers, BroadcastChannel and transport are
  released. Before, an idle process kept running after `disconnect()`.
- **A failed `connect()` no longer leaves a connected-looking instance
  (M-01).** If a plugin's `onDatabaseInit` throws, the adapter is closed, the
  instance stays disconnected, and the error propagates.
- **Packaging resolves cleanly in every module mode (M-17).** `exports` now
  declares per-condition types, `typesVersions` covers node10, and
  `@arethetypeswrong/cli` reports **no problems** for both entry points across
  node10 / node16-CJS / node16-ESM / bundler.

### Added
- `QueryRange`, `QueryKey`, `WriteContext` and `WriteOrigin` public types.
- `onDatabaseDestroy` plugin hook.
- `tests/benchmarks/core.bench.ts` — `npm run bench` works again (it previously
  failed with "No benchmark files found"), with baselines for get, count, index
  equality/range, pagination and writes over 10k records.
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
