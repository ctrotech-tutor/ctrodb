# Plan 11 — Roadmap

## Release Phases

```
Phase 0 ─→ Phase 1 ─→ Phase 2 ─→ Phase 3 ─→ Phase 4 ─→ Phase 5
  Setup     Core        Query       Storage     Plugins     Release
                      
Phase 6 ─→ Phase 7 ─→ Phase 8
  React     Docs       Polish &
  Bindings  & Example  Publish
```

---

## Phase 0: Workspace Setup (Day 1)

**Goal**: Clean repo, install tooling, verify build pipeline

### Tasks
- [ ] Delete old source files (src/, example/, rollup config, old package.json)
- [ ] Update .gitignore, create .npmignore
- [ ] Create tsconfig.json (strict mode)
- [ ] Create tsup.config.ts (ESM + CJS + IIFE)
- [ ] Create vitest.config.ts
- [ ] Create biome.json
- [ ] Create new package.json (name: ctrodb, v3.0.0-alpha.1, zero deps)
- [ ] Create tests/setup.ts (fake-indexeddb)
- [ ] Create source directory structure with stub files
- [ ] Install dependencies
- [ ] Verify: `npm run typecheck`, `npm run lint`, `npm run build`
- [ ] Initial git commit: `chore: initialize v3 workspace`
- [ ] Delete old npm package: `npm unpublish ctrodb@2.0.0 --force`

**Deliverable**: Clean repo with working build pipeline and zero dependencies

---

## Phase 1: Core Types & Primitives (Days 2-3)

**Goal**: Foundation types, error system, schema, signal, model

### Files to Implement

| File | Description |
|---|---|
| `src/types.ts` | ID, FieldDefinition, CollectionSchema, SchemaConfig, QueryCondition, QueryPlan, ChangeEvent, Plugin interface |
| `src/errors.ts` | CtrodbError, ValidationError, ConnectionError, CollectionNotFoundError, SchemaError — with helpful messages |
| `src/reactive/signal.ts` | Signal<T>, Effect — ~80 lines total, zero deps |
| `src/schema.ts` | Schema class — definition parsing, validation, version checking |

### Implementation Order
1. `types.ts` — All shared interfaces and types
2. `errors.ts` — Error classes with clear, actionable error messages
3. `reactive/signal.ts` — Signal + Effect with dependency tracking
4. `schema.ts` — Schema parsing, validation, defaults

### Tests
- [ ] Schema: valid config, invalid version, missing collections, missing fields, invalid index references
- [ ] Signal: get/set, subscribe/unsubscribe, no-notify on same value
- [ ] Effect: immediate run, re-run on dependency change, cleanup
- [ ] Errors: each error class constructs with correct message

**Deliverable**: Core types, errors, signals, and schema with unit tests

---

## Phase 2: Query Engine (Days 4-6)

**Goal**: Complete query builder, planner, and executor

### Files to Implement

| File | Description |
|---|---|
| `src/query/types.ts` | Query-specific types |
| `src/query/builder.ts` | QueryBuilder — where, orWhere, search, sort, limit, offset, fetch, first, count, observe |
| `src/query/planner.ts` | QueryPlanner — index selection, key range generation, plan optimization |
| `src/query/executor.ts` | QueryExecutor — execute plan against adapter, filtering, sorting, pagination |

### Query Engine Verification

```
Input:  query().where('age', '>=', 18).where('status', 'active').sort({ name: 'asc' }).limit(10)

Planner Output:
  strategy: 'index_scan'
  indexName: 'age'
  range: IDBKeyRange.lowerBound(18)
  postFilterConditions: [{ field: 'status', op: '==', value: 'active' }]
  sort: { field: 'name', direction: 'asc' }
  limit: 10
```

### Tests
- [ ] QueryBuilder: condition building, chaining, OR groups, empty conditions
- [ ] QueryPlanner: index selection priority, key range generation, OR plans, full scan fallback
- [ ] QueryExecutor: filtering, sorting, pagination, OR merge, edge cases (empty results, no filters)

### Query Executor (Standalone — No Adapter Needed)

The executor should work against a simple in-memory data array for unit testing. This validates the filtering/sorting/pagination logic independently of any storage backend.

```typescript
// Test helper
function testExecutor(records: any[], plan: QueryPlan): any[] {
  return new QueryExecutor().execute({
    findAll: async () => records,
    scanIndex: async (col, index, range, filters) => {
      // Simplified index scan for testing
      return records.filter(r => {
        if (!range) return true;
        // Apply range logic...
      });
    },
    ftsSearch: async () => [],
  } as any, 'test', plan, []);
}
```

**Deliverable**: Complete query engine with unit tests

---

## Phase 3: Storage Adapters (Days 7-10)

**Goal**: Memory adapter + IndexedDB adapter with full CRUD and query support

### Files to Implement

| File | Description |
|---|---|
| `src/adapter/types.ts` | StorageAdapter interface + TransactionContext |
| `src/adapter/memory.ts` | MemoryAdapter — Map-based, full CRUD, basic index scan |
| `src/adapter/idb/connection.ts` | openDB() — IndexedDB connection with upgrade handler |
| `src/adapter/idb/crud.ts` | idbCreate, idbFindById, idbFindAll, idbUpdate, idbDelete, idbScanIndex |
| `src/adapter/idb/migration.ts` | createMigrationHandler — object store + index creation |
| `src/adapter/idb/index.ts` | IndexedDBAdapter — full StorageAdapter implementation |

### Implementation Order
1. `adapter/types.ts` — StorageAdapter interface
2. `adapter/memory.ts` — Memory adapter (enables testing without IDB)
3. `adapter/idb/crud.ts` — Raw IDB CRUD functions (tested with fake-indexeddb)
4. `adapter/idb/connection.ts` + `migration.ts` — Connection and schema setup
5. `adapter/idb/index.ts` — IndexedDBAdapter

### Tests
- [ ] Memory adapter: create, findById, findAll, update, delete, scanIndex, transaction
- [ ] Memory adapter: transaction rollback on error
- [ ] IDB adapter: same CRUD operations via fake-indexeddb
- [ ] IDB adapter: schema creation and migration
- [ ] Both adapters: metadata get/set

**Deliverable**: Two working adapters with full test coverage

---

## Phase 4: Collection & Database (Days 11-13)

**Goal**: High-level Collection and Database classes that tie everything together

### Files to Implement

| File | Description |
|---|---|
| `src/model/index.ts` | Model class — Proxy-based record wrapper with direct property access |
| `src/collection.ts` | Collection class — CRUD, query creation, model conversion, observer creation |
| `src/database.ts` | Database class — lifecycle, collection management, transactions, plugin loading |
| `src/reactive/observer.ts` | QueryObserver — connects QueryBuilder to reactive signals with change tracking |
| `src/index.ts` | Public API — barrel export of all public classes and functions |

### Data Flow Verification

```
Database.connect()
  → Creates StorageAdapter
  → Runs migrations
  → Opens collections

Collection.create(data)
  → Validate data against schema (if validation plugin loaded)
  → Adapter.create(collection, data)
  → Emit 'change' event
  → Return Model(record)

Collection.query().where('field', value).fetch()
  → QueryBuilder builds conditions
  → QueryPlanner generates plan
  → QueryExecutor executes plan against adapter
  → Collection converts raw records to Models
  → Returns Model[]
```

### Tests
- [ ] Database: connect, disconnect, isConnected
- [ ] Database: getCollection, error for non-existent collection
- [ ] Collection: full CRUD, model conversion
- [ ] Model: proxy get/set, update, delete, toJSON, id property
- [ ] Observer: initial fetch, re-fetch on change, unsubscribe
- [ ] Transactions: atomic commit, rollback on error
- [ ] Full integration: create → query → observe → update → observe callback fires

**Deliverable**: Working database with CRUD, queries, and reactive observations

---

## Phase 5: Plugins (Days 14-18)

**Goal**: FTS, Relations, and Validation plugins

### Files to Implement

| File | Description |
|---|---|
| `src/plugins/index.ts` | Plugin system — loading, hook execution order |
| `src/plugins/fts/tokenizer.ts` | Tokenizer — stop words, lowercase, deduplication |
| `src/plugins/fts/indexer.ts` | FTSIndexer — inverted index management |
| `src/plugins/fts/index.ts` | FTS plugin — hooks into create/update/delete for indexing |
| `src/plugins/relations.ts` | Relations plugin — hasMany, belongsTo, hasOne; eager loading |
| `src/plugins/validation.ts` | Validation plugin — runtime field type validation |

### Tokenizer Tests

```typescript
tokenize('Hello World')           → ['hello', 'world']
tokenize('Hello, World!')         → ['hello', 'world']
tokenize('the quick brown fox')   → ['quick', 'brown', 'fox']  (stop words removed)
tokenize('')                      → []
tokenize(null)                    → []
tokenize('a')                     → []  (single stop word)
```

### Relations Tests

```typescript
// has_many
const author = await authors.create({ name: 'Tolkien' });
const post1 = await posts.create({ title: 'The Hobbit', authorId: author.id });
const post2 = await posts.create({ title: 'LOTR', authorId: author.id });
const authorPosts = await author.posts.fetch();
expect(authorPosts.length).toBe(2);

// belongs_to
const post = await posts.get(post1.id);
const postAuthor = await post.author.first();
expect(postAuthor.name).toBe('Tolkien');

// eager loading
const postsWithAuthors = await posts.query().include('author').fetch();
expect(postsWithAuthors[0]['_author']).toBeDefined();
```

### Validation Tests

```typescript
validate('users', { name: 123 }, schema)
// → throws ValidationError: 'Field "name" must be of type "string". Got: "number".'

validate('users', { email: 'invalid' }, schemaWithEmail)
// → throws: 'Field "email" must be a valid email address. Got: "invalid".'

validate('users', { age: -1 }, schemaWithMin0)
// → throws: 'Field "age" must be >= 0. Got: -1.'

validate('users', { name: 'Alice', email: 'a@b.com', age: 30 }, schema)
// → passes (no error)
```

**Deliverable**: Three fully working plugins with unit and integration tests

---

## Phase 6: React Bindings (Days 19-20)

**Goal**: React hooks for ctrodb

### Files to Implement

| File | Description |
|---|---|
| `src/bindings/react.ts` | useQuery, useDoc, useMutation hooks |

### Tests

- [ ] useQuery: returns initial results, updates on create, cleans up on unmount
- [ ] useDoc: returns single document, undefined for non-existent, updates
- [ ] useMutation: create/update/delete with loading/error state

Note: React hooks require additional test setup. Use `@testing-library/react` for hook testing.

### CDN Verification

Create a simple HTML file in `examples/cdn-todo/index.html`:

```html
<!DOCTYPE html>
<html>
<head><title>ctrodb CDN Example</title></head>
<body>
  <script src="../../dist/index.iife.js"></script>
  <script>
    const { Database } = CtroDB;
    // ... full working todo app
  </script>
</body>
</html>
```

Verify this file works by opening it in a browser (or testing with a headless browser).

**Deliverable**: React bindings + CDN verification HTML file

---

## Phase 7: Documentation & Examples (Days 21-23)

**Goal**: Comprehensive docs that make developers productive immediately

### Documentation

| Document | Content |
|---|---|
| `README.md` | What is ctrodb, quick start (CDN + npm), key features, examples, API overview |
| `docs/getting-started.md` | Installation, first database, schema, CRUD, queries |
| `docs/queries.md` | Where, orWhere, sort, pagination, search, FTS |
| `docs/reactivity.md` | Observe, signals, framework integration |
| `docs/plugins.md` | FTS, Relations, Validation — setup and usage |
| `docs/migrations.md` | Schema versioning, migration functions |
| `docs/transactions.md` | Atomic operations, rollback |
| `docs/api-reference.md` | Full API reference with types |
| `docs/migration-from-v2.md` | What changed, how to upgrade |
| `docs/migration-from-dexie.md` | Guide for Dexie users switching to ctrodb |

### Examples

| Example | Description |
|---|---|
| `examples/cdn-todo/` | Todo app using CDN script tag — no build tools |
| `examples/react-todo/` | React todo app with useQuery + useMutation |
| `examples/kanban/` | Kanban board with FTS search + relations |

**Deliverable**: README, docs directory with guides, three working examples

---

## Phase 8: Polish & Release (Days 24-28)

**Goal**: Edge cases, performance, final testing, npm release

### Pre-release Checklist

- [ ] Edge case testing:
  - [ ] Empty collections
  - [ ] Very large records (1MB+)
  - [ ] Special characters in data
  - [ ] Concurrent operations
  - [ ] Browser tab blocking/unblocking
  - [ ] IndexedDB storage quota exceeded
  - [ ] Database deletion and recreation
  - [ ] Schema migration from non-existent to v1
  - [ ] Schema migration from v1 to v2

- [ ] Performance:
  - [ ] Run benchmarks
  - [ ] Profile memory usage for large datasets (10K records)
  - [ ] Profile FTS index building

- [ ] Code quality:
  - [ ] 90%+ test coverage
  - [ ] No TypeScript errors (strict mode)
  - [ ] Biome linter passes with no warnings
  - [ ] All examples working

- [ ] Build verification:
  - [ ] ESM build works with Vite
  - [ ] CJS build works with Node.js require()
  - [ ] IIFE build works in browser script tag
  - [ ] React subpath import works
  - [ ] Tree-shaking verified (unused code excluded from bundle)

- [ ] Release:
  - [ ] Delete old npm package (if not already done)
  - [ ] Ensure package.json has correct metadata
  - [ ] `npm publish --tag alpha`
  - [ ] Verify npm page renders correctly
  - [ ] Create GitHub release with changelog

### Build Size Targets

| Format | Target Size |
|---|---|
| Core (ESM) | < 8 KB minified |
| Core (ESM + gzip) | < 3 KB |
| Full (core + FTS + relations, ESM) | < 15 KB minified |
| Full (IIFE, all included) | < 20 KB minified |
| React bindings | < 3 KB (excluding React) |

---

## Release Schedule

| Milestone | Date | Version |
|---|---|---|
| Phase 0: Workspace setup | Day 1 | — |
| Phase 1: Core types & primitives | Day 2-3 | — |
| Phase 2: Query engine | Day 4-6 | — |
| Phase 3: Storage adapters | Day 7-10 | — |
| Phase 4: Collection & Database | Day 11-13 | — |
| Internal integration checkpoint | Day 13 | v3.0.0-alpha.1 |
| Phase 5: Plugins | Day 14-18 | — |
| Phase 6: React bindings | Day 19-20 | — |
| Phase 7: Documentation & examples | Day 21-23 | — |
| Feature-complete checkpoint | Day 23 | v3.0.0-alpha.2 |
| Phase 8: Polish & testing | Day 24-27 | — |
| Release candidate | Day 27 | v3.0.0-rc.1 |
| Bug fixes & final testing | Day 28 | v3.0.0-rc.2 |
| **Stable release** | **Day 28** | **v3.0.0** |

### Post-v3.0 Plans

| Version | Features |
|---|---|
| v3.1.0 | OPFS SQLite adapter, Vue bindings, Svelte bindings, BM25 scoring, batch operations |
| v3.2.0 | Replication plugin, encryption plugin, SolidJS bindings, DevTools extension |
| v3.3.0 | Web Worker support (non-blocking operations), compaction, export/import |
