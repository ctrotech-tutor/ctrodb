# Plan 01 — Architecture

## High-Level Design

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Application                          │
├─────────────────────────────────────────────────────────────────┤
│  Framework Bindings (React/Vue/Svelte/Solid)                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  useQuery / useDoc / useMutation / useObserve             │  │
│  └───────────────────────┬───────────────────────────────────┘  │
│                          │                                       │
├──────────────────────────┴──────────────────────────────────────┤
│                        CtroDB Core                               │
│                                                                  │
│  ┌──────────┐  ┌────────────┐  ┌───────────┐  ┌───────────┐    │
│  │ Database  │  │ Collection │  │   Query    │  │   Model   │    │
│  │          │  │           │  │  Builder   │  │  (Proxy)  │    │
│  └─────┬────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘    │
│        │             │              │               │           │
│  ┌─────┴─────────────┴──────────────┴───────────────┴──────┐   │
│  │                     Event Bus (Emitter)                   │   │
│  └────────────────────────────┬─────────────────────────────┘   │
│                               │                                   │
│  ┌────────────────────────────┴─────────────────────────────┐   │
│  │                 Query Planner + Executor                   │   │
│  │    (condition analysis → index selection → IDBKeyRange)   │   │
│  └────────────────────────────┬─────────────────────────────┘   │
│                               │                                   │
│  ┌────────────────────────────┴─────────────────────────────┐   │
│  │                   Signal System                            │   │
│  │  (reactive signals, change detection, batch updates)      │   │
│  └────────────────────────────┬─────────────────────────────┘   │
│                               │                                   │
│  ┌────────────────────────────┴─────────────────────────────┐   │
│  │                 Storage Adapter Interface                  │   │
│  └──┬──────────────┬──────────────┬──────────────┬──────────┘   │
│     │              │              │              │               │
│  ┌──┴──┐     ┌─────┴─────┐  ┌───┴────┐  ┌─────┴─────┐         │
│  │ IDB │     │  Memory   │  │ Node   │  │  SQLite   │         │
│  │     │     │           │  │ fs     │  │ (future)  │         │
│  └─────┘     └───────────┘  └────────┘  └───────────┘         │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Plugins (FTS, Relations, Validation, Encryption)         │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Module Dependency Graph

```
types.ts  ←──┬── errors.ts
              │
              ├── signal.ts          (standalone, zero deps)
              │
              ├── schema.ts          (depends on: types)
              │
              ├── model.ts           (depends on: types, errors, schema)
              │
              ├── query/builder.ts   (depends on: types, query/types)
              ├── query/planner.ts   (depends on: types, query/types, schema)
              ├── query/executor.ts  (depends on: types, query/planner, adapter)
              │
              ├── adapter/types.ts   (depends on: types, schema)
              ├── adapter/memory.ts  (depends on: adapter/types, query/planner)
              ├── adapter/idb/*.ts   (depends on: adapter/types, query/planner)
              │
              ├── collection.ts      (depends on: types, model, query, adapter)
              ├── database.ts        (depends on: all of the above)
              │
              ├── plugins/*.ts       (depends on: types, database)
              │
              └── index.ts           (exports everything)
```

## Data Flow — Create Operation

```
User:   collection.create({ name: 'Alice', age: 30 })
          │
          ▼
Collection.create(data)
          │
          ├── Schema.validate(data)              ← validates types, required fields
          ├── Adapter.create(collectionName, data)
          │     │
          │     ├── (IDB) Start transaction
          │     ├── Add record to IDB object store
          │     ├── (if FTS plugin) Update inverted index
          │     ├── Commit transaction
          │     ├── Emit 'change' event
          │     └── Return raw record with id
          │
          └── Return new Model(rawRecord)
                │
                └── Proxy wraps raw data (direct property access)
```

## Data Flow — Query Operation

```
User:   collection.query().where('age', '>=', 18).fetch()
          │
          ▼
QueryBuilder.where('age', '>=', 18)
          │
          ▼
QueryBuilder.fetch()
          │
          ├── const plan = QueryPlanner.plan(conditions, collectionSchema)
          │     │
          │     ├── Analyze each condition
          │     ├── Check available indexes
          │     ├── Select best index (most selective, matching operator)
          │     ├── Build IDBKeyRange for range conditions
          │     ├── Determine post-filter conditions (non-indexed)
          │     └── Return QueryPlan { strategy, indexName, range, postFilters, sort }
          │
          ├── const rawRecords = QueryExecutor.execute(adapter, plan)
          │     │
          │     ├── If strategy is 'index_scan':
          │     │     adapter.scanIndex(collection, plan.indexName, plan.range)
          │     │     → results
          │     │     → filter by postFilters in JS
          │     │
          │     ├── If strategy is 'full_scan':
          │     │     adapter.findAll(collection)
          │     │     → filter by all conditions in JS
          │     │
          │     └── Apply sort / limit / offset
          │
          └── Return collection._toModelArray(rawRecords)
```

## Data Flow — Reactive Observe

```
User:   collection.query().where('age', '>=', 18).observe(callback)
          │
          ▼
QueryBuilder.observe(callback)
          │
          ├── Create QueryObserver
          │     │
          │     ├── Initial fetch → callback(results)
          │     ├── Subscribe to collection change events
          │     │
          │     └── On change event:
          │           ├── Check if changed record matches query conditions
          │           │     (quick match check without re-querying)
          │           ├── If relevant → schedule re-fetch (microtask debounced)
          │           ├── If not relevant → skip
          │           └── On re-fetch complete → callback(newResults)
          │
          └── Return unsubscribe function
```

## Data Flow — Transaction

```
User:   db.transaction(async (ctx) => {
          const users = ctx.collection('users');
          const posts = ctx.collection('posts');
          const user = await users.get(1);
          await posts.create({ title: 'Post', authorId: user.id });
        })
          │
          ▼
Database.transaction(callback)
          │
          ├── Adapter.beginTransaction(['users', 'posts'], 'readwrite')
          │
          ├── Create TransactionContext
          │     └── ctx.collection(name) returns a scoped Collection
          │           that uses the same transaction for all operations
          │
          ├── Execute callback(ctx)
          │
          ├── On success: commit transaction
          ├── On error: rollback transaction
          │
          └── Emit batched change events
```

## File Structure

```
src/
├── index.ts                    # Public API (barrel export)
├── types.ts                    # Core TypeScript types & interfaces
├── errors.ts                   # Custom error classes with helpful messages
│
├── database.ts                 # Database class (entry point, lifecycle)
├── schema.ts                   # Schema definition, validation, migration
├── collection.ts               # Collection class (CRUD operations)
│
├── model/
│   └── index.ts                # Model class (Proxy-based record wrapper)
│
├── query/
│   ├── index.ts                # Public query exports
│   ├── builder.ts              # QueryBuilder (fluent chainable API)
│   ├── planner.ts              # QueryPlanner (index-aware plan generation)
│   ├── executor.ts             # QueryExecutor (run plan against adapter)
│   └── types.ts                # Query-specific types (Condition, QueryPlan, etc.)
│
├── reactive/
│   ├── index.ts                # Public reactive exports
│   ├── signal.ts               # Signal<T> implementation
│   └── observer.ts             # QueryObserver (wires query to signal with change tracking)
│
├── adapter/
│   ├── index.ts                # Public adapter exports + StorageAdapter interface
│   ├── memory.ts               # In-memory adapter (for testing, Node.js)
│   │
│   └── idb/
│       ├── index.ts            # IndexedDBAdapter class
│       ├── connection.ts       # openDB() connection management
│       ├── crud.ts             # Raw IDB CRUD operations
│       └── migration.ts        # Schema migration (onupgradeneeded handler)
│
├── plugins/
│   ├── index.ts                # Plugin system + Plugin interface
│   ├── fts/
│   │   ├── index.ts            # FTS plugin
│   │   ├── tokenizer.ts        # Text tokenization with stop-word removal
│   │   ├── scorer.ts           # TF-IDF/BM25 scoring
│   │   └── indexer.ts          # Inverted index management
│   ├── relations.ts            # Relations plugin (hasMany, belongsTo, hasOne)
│   └── validation.ts           # Runtime validation plugin
│
└── bindings/
    └── react.ts                # React hooks (useQuery, useDoc, useMutation)
```

## Package Structure

```
ctrodb/                           # npm install ctrodb
├── dist/
│   ├── index.mjs                 # ESM (tree-shakeable, modern bundlers)
│   ├── index.cjs                 # CommonJS (Node.js require())
│   ├── index.iife.js             # IIFE (CDN / script tag — everything included)
│   ├── index.d.ts                # TypeScript declarations
│   ├── react.mjs                 # React hooks (ESM)
│   ├── react.cjs                 # React hooks (CJS)
│   └── react.d.ts                # React hooks types
│
├── src/                          # Full source (published for source maps)
├── package.json
└── README.md
```

## Key Design Decisions

### Why tsup over Rollup/Vite?
- Fastest build tool (esbuild under the hood)
- Native TypeScript support (no Babel needed)
- Built-in support for ESM + CJS + IIFE outputs
- Zero configuration for most use cases

### Why custom Signal class over library?
- Zero-dependency constraint
- The implementation is ~50 lines of well-tested code
- No need for complex features (batch transactions, error handling, etc.)

### Why extract FTS into a plugin?
- Not every app needs full-text search
- Keeps the core bundle smaller (~3KB instead of ~5KB)
- Clean separation of concerns
- Can be loaded conditionally

### Why separate React bindings?
- Core must be framework-agnostic
- Users who don't use React shouldn't pay for React-specific code
- Tree-shaking can't remove React dependencies if they're in the same module

### Why Memory adapter?
- Enables testing without IndexedDB (no fake-indexeddb needed)
- Enables Node.js usage (where IndexedDB doesn't exist)
- Faster for development workflows
- Allows for easy prototyping and demos
