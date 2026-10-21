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
  <a href="https://www.npmjs.com/package/ctrodb"><img src="https://img.shields.io/badge/dependencies-zero-brightgreen?style=flat" alt="zero dependencies" /></a>
  <a href="https://www.npmjs.com/package/ctrodb"><img src="https://img.shields.io/npm/dm/ctrodb?style=flat&label=downloads&color=6366f1" alt="downloads" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/types-TypeScript%20strict-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://github.com/ctrotech-tutor/ctrodb/actions"><img src="https://img.shields.io/github/actions/workflow/status/ctrotech-tutor/ctrodb/ci.yml?style=flat&branch=main&label=CI" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat" alt="license" />
</p>

---

> **Documentation site** ([ctrodb.vercel.app](https://ctrodb.vercel.app)) is currently being updated.
> For now, this README is the single source of truth.

---

## Features

| Category | Feature | Description |
|---|---|---|
| Core | Zero Dependencies | No runtime libraries. Core 53 KB minified / **16 KB gzipped**; `ctrodb/react` adds 8 KB / 3 KB. |
| | Schema Validation | Declarative schemas with type checking, defaults, required fields, format validation (email, URL, regex), min/max constraints. |
| | Proxy Models | Transparent property access on query results. Call `.update()` and `.delete()` directly on models. |
| | TypeScript Strict | Full generics, exhaustive type exports, strict mode throughout. |
| Storage | IndexedDB | Persistent browser storage — survives page reloads and tab closures. |
| | Runtime-portable queries | Indexed and range queries use storage-neutral descriptors, so identical code runs on the memory adapter in Node and on IndexedDB in the browser. |
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
<script src="https://unpkg.com/ctrodb@1.4.0/dist/index.global.js"></script>
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
import { createDatabase, defineSchema, syncPlugin, HttpTransport } from "ctrodb"

const schema = defineSchema({
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
})

const db = createDatabase({
  name: "my-app",
  schema,
  plugins: [syncPlugin({ transport: new HttpTransport({ url: "https://api.example.com/sync" }) })],
  adapter: "indexeddb", // "memory" for Node/testing
})
```

`defineSchema()` validates the declaration immediately and keeps its literal
types, so every collection is typed from the schema — no hand-written document
interfaces, no duplicated field lists:

```typescript
const users = db.collection("users")   // Collection<{ id: ID; name: string; email?: string; ... }>
await users.create({ label: "x" })     // type error: "label" is not a user field
await users.create({ email: "a@b.c" }) // type error: "name" is required
users.query().where("age", ">", 18)    // value typed from the field
users.query().where("age", ">", "18")  // type error
users.query().where("nope", 1)         // type error
```

`new Database({ ... })` still works exactly as before: without
`defineSchema()`/`createDatabase()` collections are `Collection<T>` untyped and
you pass the document type yourself (`db.collection<User>("users")`).

### 2. Connect and create records

```typescript
await db.connect()

const users = db.collection("users")
const alice = await users.create({ name: "Alice", email: "alice@test.com", age: 30 })
// alice.name === "Alice", alice.role === "user" (default applied)
// `alice.id` is a string; `alice.age` is `number | undefined`
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
const db = createDatabase({ schema, ...rest })  // Typed from the schema (recommended)
const db = new Database(config)                  // Untyped collections

await db.connect()                          // Open connection
await db.disconnect()                       // Close connection
const col = db.collection<T>("name")        // Get or create collection
await db.transaction(fn)                    // Atomic writes; hooks/events after commit
db.on(callback)                             // Subscribe to all changes
```

#### IndexedDB upgrades across tabs

When another tab opens a newer schema version, this tab's IndexedDB connection
receives `versionchange`. ctrodb closes the stale connection automatically,
marks the `Database` disconnected, and runs plugin teardown. Subscribe if the app
should prompt for a reload:

```typescript
db.onConnectionChange((event) => {
  if (event.type === "versionchange") {
    console.info(event.message)
    // Show "A new version is available — reload to continue".
  }
})
```

A blocked upgrade rejects with an actionable `ConnectionError` instead of
hanging. The outdated connection closes when it receives the upgrade event; if
the open request succeeds after the caller has already received that rejection,
ctrodb closes the late connection rather than leaking it. Reconnect with the
current schema version (an older schema cannot downgrade an IndexedDB database).

#### DatabaseConfig

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `"ctrodb"` | Database name (used for IndexedDB store name) |
| `adapter` | `"indexeddb" \| "memory" \| StorageAdapter` | auto-detect | Storage backend |
| `schema` | `SchemaConfig` | — | Schema definition. Use `defineSchema()` to derive document types |
| `plugins` | `CtroDBPlugin[]` | — | Plugins to load |

### defineSchema / createDatabase

```typescript
import { defineSchema, createDatabase } from "ctrodb"

const schema = defineSchema({ version: 1, collections: { … } })  // validated now, literal types kept
const db = createDatabase({ schema, name: "app", adapter: "indexeddb" })
```

| Export | Purpose |
|---|---|
| `defineSchema(config)` | Returns the same object, but validates it immediately and preserves literal field types so document types can be derived |
| `createDatabase(config)` | `Database` whose `collection()` is typed from the schema; assignable everywhere a `Database` is |
| `DocumentOf<S, "collection">` | Document type of one collection (useful for props and function signatures) |
| `InferRecord<C>` | Document type of a single `collections` entry |

Field typing rules:

- `required: true` → the property is required on the document and in `create()`.
- anything else → optional (`T | undefined`), including fields with a `default`
  (the default is applied on write, but rows written earlier — or arriving via
  sync — may not have the field).
- `array` fields use `items` when declared.

### Collection\<T\>

```typescript
await collection.create(data)               // Insert a record (id auto-generated)
await collection.createMany(records)        // Insert a batch atomically
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
query.search(field, term)                   // Substring match on one field
query.match(text, fields?)                  // Tokenised AND match (index-backed)
await query.fetch()                         // Execute, return models
await query.first()                         // First result or undefined
await query.count()                         // Count results
await query.toArray()                       // Return plain objects (no Proxy)
```

### Batch inserts

`createMany()` writes a batch as **one adapter operation** — one IndexedDB
transaction, one index write per batch instead of per document:

```typescript
const todos = await db.collection("todos").createMany([
  { text: "a" },
  { text: "b" },
  { text: "c" },
])
// ids are generated per record, exactly as create() would
```

It is a drop-in for a loop, not a different contract:

- validation, defaults and `onBeforeCreate` run per record, exactly as `create()` does;
- one `create` event is emitted per record, so `db.on()`, `collection.onChange()`
  and `useQuery()` see the same sequence they would from a loop;
- the result is the models in input order.

The difference is **atomicity and cost**. A batch that fails validation, repeats
an id, or violates a unique constraint writes **nothing** — the loop would leave
the records before the failure behind. Measured on the same data:

| 400 records (IndexedDB + `ftsPlugin()`) | per record | `createMany()` |
|---|---|---|
| time | 268 ms | **55 ms** (4.8x) |
| per record | 669 µs | **138 µs** |

On the in-memory adapter the difference is small (there is no transaction to
save); batching exists for the durable path.

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

#### Indexes and range queries

Declare an index for fields you filter by frequently:

```typescript
indexes: [{ field: "score" }]

await items.query().where("score", ">=", 90).fetch()
```

The memory adapter keeps distinct index keys in a lazily sorted cache, seeks to
the requested range with binary search, and invalidates the cache when a key
bucket is added or removed. It uses a sequential scan for very broad ranges,
where retrieving and copying most of the collection is cheaper than walking the
index. Both paths return the same filtered records. On a warmed 20,000-row
memory collection with a unique numeric index, a one-row range measured 0.025 ms
indexed versus 0.974 ms scanned; a 1% range measured 0.115 ms versus 0.942 ms.

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

### Write context

Every record lifecycle hook receives a final `context` argument:

```typescript
interface WriteContext {
  origin: "local" | "remote"
}
```

`origin` is `"local"` for writes made through `Collection` and `"remote"` for
data applied by the sync engine. Use it to avoid reacting to your own applied
changes — that is exactly how the sync plugin avoids re-queueing synced rows:

```typescript
const plugin: CtroDBPlugin = {
  name: "audit-log",
  onAfterCreate(collection, record, context) {
    if (context?.origin === "remote") return // mirrored data, not user intent
    void writeAuditEntry(collection, record)
  },
}
```

### Full-Text Search Plugin

Inverted-index FTS with automatic indexing on create/update/delete.

> `query().search(field, text)` performs a case-insensitive **substring** match
> on the field value; it does not consult the FTS index. The FTS plugin
> maintains an inverted index for token queries. This distinction is
> deliberate: changing `search()` to tokenised matching would silently change
> results for existing callers.

**Two different questions, deliberately:**

| call | meaning | needs the plugin |
|---|---|---|
| `query().search(field, text)` | case-insensitive **substring** on one field | no |
| `query().match(text, fields?)` | every **token** of `text` appears as a whole word | no, but the index makes it fast |

```typescript
// Substring: "quickfix" matches "quick".
await articles.query().search("title", "quick").fetch()

// Tokenised: "quickfix" does NOT match "quick", and every token must appear.
await articles.query().match("typescript database").fetch()
await articles.query().match("typescript", ["title"]).fetch()
```

Without `fields`, `match()` searches the collection's declared `searchable`
fields — exactly what the plugin indexes. With `ftsPlugin()` installed the query
becomes one index lookup per token instead of a scan of the collection; without
it, the same predicate runs over a scan. **The plugin changes how fast this
runs, never what it returns**, and the tests assert that by running every case
both ways. On 5,000 documents a one-hit query takes 0.07 ms with the index and
8.8 ms without.

Field names are typed from the document, so `match("x", ["nope"])` is a compile
error on a `defineSchema()` database, and the collection must declare
`searchable` fields (or you must pass them) or `match()` throws `QueryError`.

**Indexed search (tokenized AND) — requires `ftsPlugin()`:**
```typescript
import { FTSIndexer } from "ctrodb"

const indexer = new FTSIndexer(adapter)
const ids = await indexer.search("articles", "typescript database")
// Only documents matching ALL tokens
```

Features: tokenization, stop-word removal, case-insensitive, multi-field, automatic index updates on create/update/delete.

The index stores **one record per (collection, token, document)** posting, so a
write costs one independent insert per token, a delete costs one delete per
token, and neither has to read the index first. That matters at scale and under
concurrency: the previous layout kept a `docIds` array per token and rewrote it
on every write, which was quadratic (8,000 documents took 4.0 s instead of
0.26 s) and lost entries when writes overlapped (50 concurrent `create()` calls
left 1 of 50 documents indexed).

The plugin declares a `token` index on its store, which `FTSIndexer.search()`
uses for a single index scan per query token. Construct an `FTSIndexer`
directly over an adapter connected without a schema and it falls back to
reading the posting store — same results, slower. Indexes from an earlier
format are detected and rebuilt once at `connect()`.

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

**Lazy loading — `model.load()`, typed:**
```typescript
const author   = await post.load("author")    // belongs_to → one record
const comments = await post.load("comments")  // has_many → array
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

## Transactions

`db.transaction(fn)` runs a set of writes atomically on **both** adapters:

```typescript
await db.transaction(async (tx) => {
  const accounts = tx.collection("accounts")
  const from = await accounts.findById("alice")
  if (!from || from.balance < 100) throw new Error("insufficient funds")

  await accounts.update("alice", { balance: from.balance - 100 })
  await accounts.create({ id: "deposit", owner: "bob", balance: 100 })
})
// Resolves only after the change is durably committed.
// If the callback throws, no write is applied and your error is rethrown as-is.
```

Rules that apply to both adapters:

- **Use `tx.collection(name)` inside the callback.** Writes made through
  `db.collection(...)` are separate operations; they are not rolled back with
  the transaction. (On IndexedDB they cannot be: a collection write opens its
  own transaction.)
- **Do not await non-database work** (timers, `fetch`, `setTimeout`) inside the
  callback. IndexedDB commits as soon as its transaction goes idle; waiting on
  anything else ends the transaction early. Do the I/O first, then open the
  transaction.
- A resolved promise means *committed*, not merely "the callback returned".
- Transactional `create`/`update` writes get the same schema defaults and validation as collection writes; `onBefore*` hooks run before each adapter operation.
- `onAfter*` hooks and change events run **after commit**, in write order. They are not run if the transaction aborts. This keeps plugin side effects (such as FTS postings) out of rolled-back transactions and avoids opening a second IndexedDB transaction while the first is active.
- After-hook failures are reported through the normal plugin error path; they do not turn a durable commit into a rejected promise.

## Schema strictness

With a schema configured, the schema is the source of truth:

- `db.collection(name)` throws `CollectionNotFoundError` for a collection that
  is not declared (internal stores use a leading underscore and are exempt).
- Field types are checked structurally: `array` requires an array, `object`
  rejects arrays and `null`, and `number` rejects `NaN`.
- Updating a missing record throws `RecordNotFoundError`; creating a duplicate
  id throws a duplicate-record error. Both are exported classes, so prefer
  `instanceof` over matching message text.

## Models

Query results are `Model` instances that forward property reads to the stored
record, so `todo.text` and `user.name` work as expected, and `.update()` /
`.delete()` act on that record.

```ts
const todo = await db.collection("todos").get("t1")
todo.text                                  // stored field
await todo.update({ done: true })
await todo.delete()

Object.keys(todo)                          // ["id", "text", "done", ...]
const plain = { ...todo }                  // a plain object of the record
```

Direct assignment (`todo.text = "x"`) throws: it cannot persist on its own, and
silently accepting it used to look successful while losing the change. Use
`update()`.

### Relations

Relations are declared in the schema; there are two ways to read them, and the
difference is *when* the read happens — not what it returns:

```ts
const author = await db.collection("authors").get("a1")

// Lazy: one round-trip per model, when you ask.
const posts = await author.load("posts")            // has_many → Model[]
const post  = await db.collection("posts").get("p1")
const owner = await post.load("author")             // belongs_to → one Model

// Eager: one round-trip per collection, for a whole result set.
const withPosts = await db.collection("authors").with("posts").fetch()
withPosts[0].posts                                  // resolved Model[]
```

With a `defineSchema()` schema, the resolved type is derived from the relation:
`await post.load("author")` is `User | undefined`, `await user.load("posts")` is
`Post[]`, and a name that is not a relation of that collection is a type error.

`load(name)` resolves to an array for `has_many` and to a single record for
`has_one`/`belongs_to`. It rejects when the name is not a declared relation,
instead of resolving `undefined`.

`model.<relation>` is the same relation as a lazy `QueryBuilder`, for when you
want to filter before loading — and it is typed from the schema too:

```typescript
const latest = await post.author.sort({ name: "desc" }).first()  // Author | undefined
const drafts = await author.posts.where("draft", "==", true).fetch()  // Post[]
```

A relation that the collection does not declare is a compile error, and so is
reaching a relation through the wrong shape (e.g. `post.author.posts`).

## Ordering

`query().fetch()` returns records in **primary-key ascending** order unless you
ask for a different one, identically on every adapter:

```typescript
await todos.query().limit(20)                 // deterministic page 1
await todos.query().sort({ createdAt: "desc" }) // explicit ordering
```

Ordering applies to `offset()`/`limit()` windows and to `orWhere()` queries as
well. Before this guarantee, the memory adapter returned insertion order while
IndexedDB returned key order, so pagination differed between tests and
production and an `orWhere()` query silently ignored the requested order.

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

### Conflict semantics (pull)

Sync runs `push` then `pull`. Every remote change is applied as a real write —
schema validation, plugin hooks, full-text indexing and change events all run,
so reactive queries update and `db.on()` fires exactly as for a local edit
(remote writes are marked with `origin: "remote"` and are never re-queued).

When a remote change targets a record that still has a queued local change, the
**newer side wins**:

| Situation | Result |
|---|---|
| Queued local change is newer than the remote change | Local value is kept; the remote snapshot is treated as a replay |
| Remote change is newer | Remote value is applied; the superseded local change is drained from the queue |
| Timestamps are equal | Remote wins — identical to the LWW conflict resolver |

The queue is snapshotted *before* the push phase, so a server echo of data this
client just pushed can never roll the local value backwards. Failed pushes are
rolled back to `pending` (never left in `syncing`), and a remote record that
fails schema validation aborts the pull with a sync `error` event instead of
being silently stored.

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
  const { isConnected, pendingChanges } = useSyncStatus()
  const { sync } = useSync()

  return (
    <div>
      <span>Connected: {isConnected ? "Yes" : "No"}</span>
      <span>Pending: {pendingChanges}</span>
      <button onClick={() => void sync()}>Sync Now</button>
    </div>
  )
}

// The panel reads the database from <DatabaseProvider>.
function AdminPanel() {
  return <SyncDevPanel />
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
| `useQuery<T>(name, queryFn?, deps?)` | `{ data: (Model<T> & T)[]; loading: boolean; error: Error \| undefined }` | Reactive query; refetches on changes for that collection |
| `useDoc<T>(name, id)` | `{ data: (Model<T> & T) \| undefined; loading: boolean; error: Error \| undefined }` | Single document by ID |
| `useMutation<T>(name)` | `{ create, update, delete, loading, error, reset }` | CRUD with loading/error state; `delete` is aliased from `del` |
| `useSyncStatus()` | `{ isSyncing, isConnected, lastSyncAt, pendingChanges, failedChanges, lastError }` | Sync connection state and queue counts (polls every second) |
| `useSync(callback?)` | `{ sync: () => Promise<void>; status: SyncStatusResult }` | Trigger a sync and observe its status |
| `useSyncQueue()` | `{ snapshot: SyncQueueSnapshot; loading: boolean; error?: Error; refresh: () => Promise<void> }` | Live sync queue for dev tools |
| `useDatabase()` | `Database` | The instance from `<DatabaseProvider>` |
| `<DatabaseProvider db>` / `<SyncDevPanel />` | — | Context provider and a ready-made queue inspector |

`deps` is a dependency array with the same meaning as in `useEffect`, with one
difference: its **length may change between renders** (React forbids that for
`useEffect`, and the hook used to forward it directly). Values are compared with
`Object.is`, so pass primitives or memoised objects.

```tsx
// Re-runs whenever `status` or `page` changes.
const { data, loading, error } = useQuery("todos", (q) => q.where("status", "==", status), [
  status,
  page,
])
```

Behaviour worth knowing:

- **`loading` is only true for the first load.** A background refetch keeps the
  current data on screen and leaves `loading` false, so lists do not flash.
- **Change events are coalesced** (one animation frame); a bulk import or a sync
  pull triggers one refetch, not one per record.
- **Responses are sequenced.** A slow query that resolves after a newer one is
  discarded instead of overwriting fresher data.
| `<SyncDevPanel maxEvents? />` | Component | Dark-themed sync admin panel (reads the db from context) |

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
├── unit/             # Unit tests
├── node/             # Pure-Node tests (no IndexedDB globals)
├── integration/      # Cross-component and regression tests
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
npm test              # Run all test projects
npm run typecheck     # TypeScript check (src)
npm run verify        # typecheck + lint + build + package checks + tests
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
| `npm run typecheck` | TypeScript type checking (`src/`) |
| `npm run typecheck:tests` | TypeScript type checking (`tests/`) |
| `npm run verify` | Full pre-release gate (typecheck, lint, build, package verification, tests) |
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
