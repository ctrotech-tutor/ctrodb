<p align="center">
  <img alt="ctrodb" src="/public/logo.png" width="400" />
</p>

<p align="center">
  <strong>Zero-dependency, reactive, client-side database for browser and Node.js</strong>
  <br />
  Schema-driven · Full-text search · Relations · Offline Sync · React hooks · IndexedDB persistence
</p>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-installation">Installation</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-api">API</a> •
  <a href="#-plugins">Plugins</a> •
  <a href="#-sync-engine">Sync</a> •
  <a href="#-react">React</a>
</p>

<p align="center">
  <a href="https://github.com/ctrotech-tutor/ctrodb/releases"><img src="https://img.shields.io/github/v/release/ctrotech-tutor/ctrodb?style=flat&label=version&color=6366f1" alt="version" /></a>
  <a href="https://www.npmjs.com/package/ctrodb"><img src="https://img.shields.io/badge/dependencies-zero-brightgreen?style=flat" alt="zero dependencies" /></a>
  <a href="https://bundlephobia.com/package/ctrodb"><img src="https://img.shields.io/bundlephobia/minzip/ctrodb?style=flat&label=size&color=22c55e" alt="size" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/types-TypeScript%20strict-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://github.com/ctrotech-tutor/ctrodb/actions"><img src="https://img.shields.io/github/actions/workflow/status/ctrotech-tutor/ctrodb/publish.yml?style=flat&branch=main&label=build" alt="build" /></a>
  <a href="https://github.com/ctrotech-tutor/ctrodb/actions"><img src="https://img.shields.io/github/actions/workflow/status/ctrotech-tutor/ctrodb/ci.yml?style=flat&branch=main&label=CI" alt="ci" /></a>
  <a href="https://codecov.io/gh/ctrotech-tutor/ctrodb"><img src="https://img.shields.io/badge/tests-477%20passing-success?style=flat" alt="tests" /></a>
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat" alt="license" />
</p>

---

> **Documentation site** ([ctrodb.vercel.app](https://ctrodb.vercel.app)) is currently being updated.
> For now, this README is the single source of truth.

---

## Features

| Category | Feature | Description |
|---|---|---|
| Core | Zero Dependencies | No runtime libraries. Core ~25 KB minified. |
| | Schema Validation | Declarative schemas with type checking, defaults, required fields, format validation (email, URL, regex), min/max constraints. |
| | Proxy Models | Transparent property access on query results. Call `.update()` and `.delete()` directly on models. |
| | TypeScript Strict | Full generics, exhaustive type exports, strict mode throughout. |
| Storage | IndexedDB | Persistent browser storage — survives page reloads and tab closures. |
| | Memory Adapter | In-memory store for Node.js, testing, and prototyping. Auto-detected. |
| | UUID IDs | Collision-free IDs via `crypto.randomUUID()`. No auto-increment conflicts across tabs. |
| Query | Fluent Builder | Chain `.where()`, `.sort()`, `.limit()`, `.offset()` — MongoDB-style. |
| | Index-Aware Planner | Automatically selects the best index for each query. Falls back to `id_lookup` for direct ID access. |
| | OR Groupings | `.orWhere()` for complex filter logic. |
| | Pagination | `.limit()` + `.offset()` for cursor-based or page-based pagination. |
| Reactivity | Signal-Based | Subscribe to collection or database-level change events. Automatic re-rendering in React. |
| | Change Events | `create`, `update`, `delete` events with old/new record snapshots. |
| Plugins | Full-Text Search | Inverted-index FTS with tokenization, stop-word filtering, and multi-field search. |
| | Relations | `has_many`, `belongs_to`, `has_one` — lazy getters and eager loading via `.with()`. |
| | Validation | Extensible rule engine with built-in email, URL, and no-empty-string validators. |
| React | useQuery | Reactive queries that auto-refetch on data changes. Returns `{ data, loading, error }`. |
| | useDoc | Single-document reactive fetch by ID. |
| | useMutation | CRUD operations with loading and error state tracking. |
| | useSyncStatus | Sync engine connection and queue status. |
| | useSyncQueue | Real-time queue inspection with SyncDevPanel component. |
| Sync | Offline-First | All mutations recorded locally first; sync queue persists via `_ctrodb_sync_changes`. |
| | Conflict Resolution | LWW (default), client-wins, server-wins, and custom resolvers. |
| | HTTP Transport | Fetch-based with timeout, abort signals, cursor pagination. |
| | WebSocket Transport | Request/response matching, auto-reconnect, server push. |
| | Multi-Tab Sync | BroadcastChannel cross-tab change notification. |
| | DevTools API | Queue inspection, retry, compaction, event log. |
| | Reference Server | Express + WebSocket sync server in `examples/sync/server-node/`. |
| Distribution | Universal Build | ESM, CJS, and IIFE (CDN-ready) outputs. Works everywhere JavaScript runs. |
| | CDN Ready | Use via `<script>` tag — no bundler required. |

---

## Installation

```bash
npm install ctrodb
```

### CDN (script tag)

```html
<script src="https://unpkg.com/ctrodb@1.3.0/dist/index.global.js"></script>
<script>
  const { Database } = CtroDB
  const db = new Database({ name: "my-app" })
  await db.connect()
</script>
```

---

## Quick Start

### 1. Define a schema

```typescript
import { Database, syncPlugin, HttpTransport } from "ctrodb"

const db = new Database({
  name: "my-app",
  plugins: [syncPlugin({ transport: new HttpTransport({ url: "https://api.example.com/sync" }) })],
  adapter: "indexeddb", // "memory" for Node/testing
  schema: {
    version: 1,
    collections: {
      users: {
        fields: {
          name: { type: "string", required: true },
          email: { type: "string", validate: "email" },
          age: { type: "number", min: 0, max: 150 },
          role: { type: "string", default: "user" },
        },
        indexes: [{ field: "email", unique: true }],
      },
    },
  },
})
```

### 2. Connect and create records

```typescript
await db.connect()

const users = db.collection("users")
const alice = await users.create({ name: "Alice", email: "alice@test.com", age: 30 })
// alice.name === "Alice", alice.role === "user" (default applied)
```

### 3. Query with the fluent builder

```typescript
const results = await users
  .query()
  .where("age", ">=", 18)
  .where("age", "<=", 65)
  .sort({ name: "asc" })
  .limit(10)
  .fetch()

// Direct property access via Proxy
console.log(results[0].name)
```

### 4. Update and delete through models

```typescript
await alice.update({ age: 31 })
await alice.delete()
```

### 5. React to changes

```typescript
const unsub = users.onChange((event) => {
  console.log(event.type, event.recordId, event.record)
})
```

---

## API

### Database

```typescript
const db = new Database(config)

await db.connect()                          // Open connection
await db.disconnect()                       // Close connection
const col = db.collection<T>("name")        // Get or create collection
await db.transaction(fn)                    // Run in transaction
db.on(callback)                             // Subscribe to all changes
```

#### DatabaseConfig

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `"ctrodb"` | Database name (used for IndexedDB store name) |
| `adapter` | `"indexeddb" \| "memory" \| StorageAdapter` | auto-detect | Storage backend |
| `schema` | `SchemaConfig` | — | Schema definition |
| `plugins` | `CtroDBPlugin[]` | — | Plugins to load |

### Collection\<T\>

```typescript
await collection.create(data)               // Insert a record (id auto-generated)
await collection.get(id)                    // Find by ID
await collection.getAll()                   // Fetch all records
await collection.update(id, changes)        // Partial update
await collection.delete(id)                 // Delete by ID
await collection.deleteMany(ids)            // Bulk delete
await collection.put(data)                  // Upsert (create or update)
await collection.count()                    // Record count
collection.query()                          // Get a QueryBuilder
collection.with(...relations)               // Get a QueryBuilder with eager loading
collection.onChange(callback)               // Subscribe to collection changes
```

### QueryBuilder\<T\>

```typescript
query.where(field, op, value)               // Add filter (op: ==, !=, >, <, >=, <=)
query.orWhere((q) => q.where(...))           // OR group
query.sort({ field: "asc" | "desc" })       // Sort
query.limit(n)                              // Limit results
query.offset(n)                             // Skip results
query.search(field, term)                   // Full-text search
await query.fetch()                         // Execute, return models
await query.first()                         // First result or undefined
await query.count()                         // Count results
await query.toArray()                       // Return plain objects (no Proxy)
```

### Model\<T\>

```typescript
model.id                                    // Record ID (UUID string)
model.update(changes)                       // Update this record
model.delete()                              // Delete this record
model.toJSON()                              // Return plain object
// + direct property access to all fields via Proxy
// + lazy relation getters (e.g., await post.author.first())
```

### Schema

```typescript
const schema = new Schema({
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string", required: true },
        email: { type: "string", validate: "email" },
        age: { type: "number", min: 0, max: 150, default: 18 },
      },
      indexes: [{ field: "email", unique: true }],
      searchable: ["name", "bio"],
      relations: {
        posts: { type: "has_many", collection: "posts", foreignKey: "userId" },
        profile: { type: "has_one", collection: "profiles", foreignKey: "userId" },
      },
    },
  },
})
```

#### Field Options

| Option | Type | Description |
|---|---|---|
| `type` | `"string" \| "number" \| "boolean" \| "object" \| "array"` | Field data type |
| `required` | `boolean` | Field must be provided at creation |
| `default` | `unknown` | Default value if not provided |
| `validate` | `"email" \| "url" \| RegExp \| ((v) => boolean)` | Format validation |
| `min` | `number` | Minimum value (number fields) |
| `max` | `number` | Maximum value (number fields) |
| `maxLength` | `number` | Maximum string length |
| `items` | `FieldDefinition` | Item type for array fields |
| `unique` | `boolean` | Enforce uniqueness (via index) |

---

## Plugins

Plugins extend ctrodb through lifecycle hooks. Load them in the `Database` constructor:

```typescript
import { Database } from "ctrodb"
import { ftsPlugin, relationsPlugin, validationPlugin } from "ctrodb"

const db = new Database({
  name: "my-app",
  schema: { ... },
  plugins: [
    validationPlugin(),     // 1. Validate first
    ftsPlugin(),            // 2. Index for search
    relationsPlugin(),      // 3. Eager loading
  ],
})
```

### Full-Text Search Plugin

Inverted-index FTS with automatic indexing on create/update/delete.

**Basic search (substring matching) — no plugin required:**
```typescript
// Case-insensitive substring search
const results = await articles.query().search("title", "typescript").fetch()
```

**Indexed search (tokenized AND) — requires `ftsPlugin()`:**
```typescript
import { FTSIndexer } from "ctrodb"

const indexer = new FTSIndexer(adapter)
const ids = await indexer.search("articles", "typescript database")
// Only documents matching ALL tokens
```

Features: tokenization, stop-word removal, case-insensitive, multi-field, automatic index updates on create/update/delete.

### Relations Plugin

Define relationships in your schema and load them eagerly or lazily.

**Schema definition:**
```typescript
relations: {
  author: { type: "belongs_to", collection: "users", foreignKey: "userId" },
  comments: { type: "has_many", collection: "comments", foreignKey: "postId" },
}
```

**Eager loading — `.with()` (built-in, no plugin needed):**
```typescript
const posts = await postsCol.with("author", "comments").fetch()
// posts[0].author  — resolved user object
// posts[0].comments — resolved comment array
```

**Lazy loading — getters (built into Model):**
```typescript
const author = await post.author.first()      // belongs_to
const comments = await post.comments.fetch()  // has_many
```

> Note: `relationsPlugin()` is still required in the plugins array for the plugin system to recognize and initialize relation metadata.

### Validation Plugin

Extensible validation with built-in and custom rules:

```typescript
const db = new Database({
  plugins: [
    validationPlugin([
      {
        name: "noReservedNames",
        validate(collection, field, value, data) {
          if (value === "admin") return "Username 'admin' is reserved"
          return null
        },
      },
    ]),
  ],
})
```

**Built-in rules:** `email` format, `url` format, `noEmptyStrings` (applied to required fields only).

---

## Sync Engine

ctrodb's sync engine provides **offline-first** synchronization with any backend. All mutations are recorded locally first; the sync queue persists via `_ctrodb_sync_changes`. Conflicts are resolved deterministically.

### Quick Start

```typescript
import { Database, syncPlugin, HttpTransport } from "ctrodb"

const db = new Database({
  name: "my-app",
  schema: { version: 1, collections: { todos: { fields: { text: { type: "string" } } } } },
  plugins: [
    syncPlugin({
      transport: new HttpTransport({ url: "https://my-api.com/sync" }),
      autoSync: { intervalMs: 30000 },
    }),
  ],
})

await db.connect()

// Manual sync
await db.sync()

// Listen for sync events
db.onSync((event) => {
  console.log(event.phase, event.progress)
})
```

### Plugin Config

| Option | Type | Default | Description |
|---|---|---|---|
| `transport` | `SyncTransport` | — | HTTP or WebSocket transport |
| `strategy` | `"lww" \| "client-wins" \| "server-wins" \| "custom"` | `"lww"` | Conflict resolution strategy |
| `autoSync` | `boolean \| { intervalMs?, debounceMs? }` | `false` | Enable automatic periodic sync |
| `collections` | `string[]` | all | Collections to sync |
| `pushBatchSize` | `number` | `50` | Changes per push request |
| `pullBatchSize` | `number` | `100` | Changes per pull request |

### Transports

**HTTP Transport** — fetch-based with timeout and abort:

```typescript
import { HttpTransport } from "ctrodb"

const transport = new HttpTransport({
  url: "https://api.example.com/sync",
  timeoutMs: 10000,
  headers: { Authorization: "Bearer token" },
})
```

**WebSocket Transport** — real-time with auto-reconnect:

```typescript
import { WsTransport } from "ctrodb"

const transport = new WsTransport({
  url: "wss://api.example.com/sync",
  reconnectIntervalMs: 3000,
  maxReconnectAttempts: 10,
})

transport.onServerPush((changes) => {
  console.log("Real-time update:", changes)
})
```

### React Hooks

```tsx
import { useSyncStatus, useSync, useSyncQueue, SyncDevPanel } from "ctrodb/react"

function SyncStatus() {
  const status = useSyncStatus()
  const sync = useSync()

  return (
    <div>
      <span>Connected: {status.isConnected ? "Yes" : "No"}</span>
      <span>Pending: {status.pendingChanges}</span>
      <button onClick={sync}>Sync Now</button>
    </div>
  )
}

function AdminPanel() {
  return <SyncDevPanel db={db} />
}
```

### DevTools API

```typescript
import { inspectSyncQueue, retryFailedSync, compactSyncQueue } from "ctrodb"

const snapshot = await inspectSyncQueue(db)
console.log(snapshot.stats) // { total, pending, syncing, committed, failed }

await retryFailedSync(db)    // Retry all failed changes
await compactSyncQueue(db)   // Deduplicate per (collection, recordId)
```

### Reference Server

A complete Node.js sync server is available in `examples/sync/server-node/`:

```bash
cd examples/sync/server-node
npm install
npm run dev
```

Includes Express + WebSocket, push/pull routes, conflict detection, cursor pagination, CORS, and graceful shutdown.

---

## React

```bash
npm install ctrodb react
```

```tsx
import { Database } from "ctrodb"
import { DatabaseProvider, useQuery, useMutation } from "ctrodb/react"

const db = new Database({ name: "my-app", adapter: "indexeddb", schema: { ... } })
await db.connect()

function App() {
  return (
    <DatabaseProvider db={db}>
      <TodoList />
    </DatabaseProvider>
  )
}

function TodoList() {
  const { data: todos, loading } = useQuery("todos", (q) => q.sort({ createdAt: "desc" }))
  const { create, delete: remove } = useMutation("todos")

  if (loading) return <div>Loading...</div>

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          {todo.text}
          <button onClick={() => remove(todo.id)}>Delete</button>
        </li>
      ))}
      <button onClick={() => create({ text: "New task" })}>Add</button>
    </ul>
  )
}
```

### Hooks API

| Hook | Returns | Description |
|---|---|---|
| `useQuery<T>(name, queryFn?, deps?)` | `{ data: (Model<T> & T)[]; loading: boolean; error: Error \| null }` | Reactive query, re-fetches on changes |
| `useDoc<T>(name, id)` | `{ data: (Model<T> & T) \| undefined; loading: boolean; error: Error \| null }` | Single document by ID |
| `useMutation<T>(name)` | `{ create, update, delete, loading, error, reset }` | CRUD with loading/error state |
| `useSyncStatus()` | `SyncStatus` | Poll + event-driven sync status (connected, pending/failed changes) |
| `useSync(callback?)` | `() => Promise<void>` | Trigger manual sync + optional event listener |
| `useSyncQueue(db)` | `SyncQueueSnapshot` | Real-time sync queue for dev tools |
| `<SyncDevPanel db={db} />` | Component | Dark-themed sync admin panel with stats, retry, event log |

---

## Examples

| Example | Location | Description |
|---|---|---|
| CDN Todo App | [`examples/cdn/index.html`](examples/cdn/index.html) | Browser todo app via `<script>` tag |
| Node.js CLI | [`examples/node/index.mjs`](examples/node/index.mjs) | CRUD, queries, FTS in Node.js |
| React Integration | [`tests/unit/react.test.tsx`](tests/unit/react.test.tsx) | Hook API usage patterns |
| Sync Reference Server | [`examples/sync/server-node/`](examples/sync/server-node/) | Express + WebSocket sync server |
| Sync Supabase Guide | [`examples/sync/server-supabase/README.md`](examples/sync/server-supabase/README.md) | BaaS integration patterns |

---

## Architecture

```
┌──────────────────────────────────────────────┐
│            User Code / Framework              │
├──────────────────────────────────────────────┤
│    Database       Collection     Plugin API   │
├──────────────────────────────────────────────┤
│    QueryBuilder   QueryPlanner               │
│    QueryExecutor  Schema/Model               │
├──────────────────────────────────────────────┤
│    MemoryAdapter  IndexedDBAdapter           │
│    (Node/testing) (production browser)       │
├──────────────────────────────────────────────┤
│    SyncEngine     ChangeTracker              │
│    ConflictResolver  SyncTransport           │
│    HttpTransport  WsTransport                │
├──────────────────────────────────────────────┤
│    Reactivity System (Signal-based)          │
└──────────────────────────────────────────────┘
```

### Project Structure

```
src/
├── adapter/          # Storage adapters (Memory, IndexedDB)
├── model/            # Proxy-based record wrapper
├── plugins/          # FTS, Relations, Validation plugins
├── query/            # Query engine (builder, planner, executor)
├── reactive/         # Signal reactivity system
├── sync/             # Sync engine (change tracker, conflict resolver,
│                     #   engine, HTTP/WS transports, devtools, validation)
├── utils/            # Plugin hook runner
├── collection.ts     # Collection CRUD + change events
├── database.ts       # Database entry point
├── errors.ts         # Error classes
├── index.ts          # Public API barrel exports
├── react.ts          # React hooks (useQuery, useDoc, useMutation,
│                     #   useSyncStatus, useSync, useSyncQueue)
├── schema.ts         # Schema definition and validation
└── types.ts          # Core TypeScript interfaces
tests/
├── unit/             # Unit tests (25 files, 477 tests)
├── benchmarks/       # Performance benchmarks (WIP)
├── integration/      # Cross-component tests
└── e2e/              # End-to-end sync tests
examples/
├── cdn/              # Browser CDN example
├── node/             # Node.js CLI example
└── sync/             # Sync reference server + integration guides
```

---

## Migration from v1.0.x

### v1.1.0 Breaking Changes

**1. `useQuery` / `useDoc` return `{ data, loading, error }`**

```diff
- const todos = useQuery("todos")
+ const { data: todos, loading } = useQuery("todos")

- const post = useDoc("posts", id)
+ const { data: post } = useDoc("posts", id)
```

**2. IDs are now UUID strings instead of auto-incremented numbers**

All records created via `Collection.create()` get a UUID string ID. Foreign key fields in relation schemas must use `type: "string"`.

```diff
- authorId: { type: "number", required: true }
+ authorId: { type: "string", required: true }
```

**3. Plugin hooks can now be async**

Custom plugin hooks may return a Promise — `runHook` now `await`s results before passing data to the next hook.

**4. `Collection.create()` now requires all schema-defined fields**

The TypeScript signature uses `Omit<T, "id"> & { id?: ID }` instead of `Partial<T>`. Missing required fields are caught at compile time.

```diff
- await users.create({ name: "Alice" })             // age missing — runtime OK, compile error now
+ await users.create({ name: "Alice", age: 30 })    // all fields provided
```

---

## Development

```bash
git clone https://github.com/ctrotech-tutor/ctrodb.git
cd ctrodb
npm install

npm run dev           # Watch mode
npm test              # Run tests (477 tests)
npm run typecheck     # TypeScript check
npm run lint          # Biome lint
npm run build         # Build ESM + CJS + IIFE
npm run bench         # Run benchmarks
```

### Commands

| Command | Description |
|---|---|
| `npm test` | Run all tests |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Coverage report |
| `npm run build` | Build all output formats (ESM + CJS + IIFE + DTS) |
| `npm run dev` | Watch build |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | Biome lint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Format source code |

---

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- **Bug reports** — Open an issue with reproduction steps.
- **Feature requests** — Open an issue with use case and proposed API.
- **Pull requests** — Fork from `main`, follow code style, add tests.

All contributors must follow our [Code of Conduct](CONTRIBUTING.md#code-of-conduct).

---

## Security

Report security vulnerabilities to **[security@ctrodb.dev](mailto:security@ctrodb.dev)**.
See [SECURITY.md](SECURITY.md) for supported versions and disclosure process.

---

## License

[MIT](LICENSE) © 2026 Ctrotech

---

<p align="center">
  <a href="https://github.com/ctrotech-tutor/ctrodb">GitHub</a> •
  <a href="https://ctrodb.vercel.app">Documentation</a> •
  <a href="https://www.npmjs.com/package/ctrodb">npm</a> •
  <a href="https://github.com/ctrotech-tutor/ctrodb/issues">Issues</a>
</p>
