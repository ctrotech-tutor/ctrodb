<p align="center">
  <img alt="ctrodb" src="/public/logo.png" width="400" />
</p>

<h1 align="center">ctrodb</h1>

<p align="center">
  <strong>Zero-dependency, reactive, client-side database for browser and Node.js</strong>
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#api">API</a> •
  <a href="#plugins">Plugins</a> •
  <a href="#react">React</a> •
  <a href="#examples">Examples</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.1-blue" alt="version" />
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/build-tsup-red" alt="build" />
  <img src="https://img.shields.io/badge/coverage-173%20tests-success" alt="tests" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
</p>

---

## Overview

**ctrodb** is a reactive, client-side database built from scratch with **zero runtime dependencies**. It provides a MongoDB-like API, full TypeScript support, IndexedDB persistence, Signal-based reactivity, and an extensible plugin system.

Perfect for local-first web apps, offline-capable PWAs, Electron applications, and any project that needs structured client-side data storage without the overhead of a large framework.

### Features

| Feature | Description |
|---|---|
| **Zero Dependencies** | No external libraries. Core ~25 KB minified. |
| **Reactive** | Signal-based change propagation. Subscribe to collection or database events. |
| **Schema Validation** | Declarative schemas with type checking, defaults, required fields, format validation (email, URL, regex), min/max constraints. |
| **Query Engine** | Fluent builder with index-aware planning, OR groupings, sort, pagination (limit/offset), full-text search. |
| **Proxy Models** | Transparent property access on query results. Call `.update()` and `.delete()` directly on models. |
| **Flexible Storage** | Memory adapter (testing/Node) and IndexedDB adapter (production browsers) with auto-detect. |
| **Plugin System** | Lifecycle hooks (`onBeforeCreate`, `onAfterUpdate`, etc.) for extensibility. |
| **Full-Text Search** | Inverted-index FTS plugin with tokenization, stop-word filtering, multi-field search. |
| **Relations** | `has_many`, `belongs_to`, `has_one` with lazy getters and eager loading. |
| **React Hooks** | `useQuery`, `useDoc`, `useMutation`, `DatabaseProvider` — reactive UI updates. |
| **Universal Build** | ESM, CJS, and IIFE (CDN-ready) outputs. Works everywhere JavaScript runs. |
| **TypeScript Strict** | Full generics, exhaustive type exports, strict mode throughout. |

---

## Installation

```bash
npm install ctrodb
```

### CDN (script tag)

```html
<script src="https://unpkg.com/ctrodb@latest/dist/index.global.js"></script>
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
import { Database } from "ctrodb"

const db = new Database({
  name: "my-app",
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

**`DatabaseConfig`:**

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | `"ctrodb"` | Database name (used for IndexedDB store name) |
| `adapter` | `"indexeddb" \| "memory" \| StorageAdapter` | auto-detect | Storage backend |
| `schema` | `SchemaConfig` | — | Schema definition |
| `plugins` | `CtroDBPlugin[]` | — | Plugins to load |
| `logLevel` | `string` | `"silent"` | Logging level |

### Collection\<T\>

```typescript
await collection.create(data)               // Insert a record
await collection.get(id)                    // Find by ID
await collection.getAll()                   // Fetch all records
await collection.update(id, changes)        // Partial update
await collection.delete(id)                 // Delete by ID
await collection.deleteMany(ids)            // Bulk delete
await collection.put(data)                  // Upsert (create or update)
await collection.count()                    // Record count
collection.query()                          // Get a QueryBuilder
collection.onChange(callback)               // Subscribe to collection changes
```

### QueryBuilder\<T\>

```typescript
query.where(field, op, value)               // Add filter (op: ==, !=, >, <, >=, <=)
query.orWhere((q) => q.where(...))           // OR group
query.sort({ field: "asc" | "desc" })       // Sort
query.limit(n)                              // Limit results
query.offset(n)                             // Skip results
query.search(field, term)                   // Full-text search (basic fallback)
await query.fetch()                         // Execute, return models
await query.first()                         // First result or undefined
await query.count()                         // Count results
await query.toArray()                       // Return plain objects (no Proxy)
```

### Model\<T\>

```typescript
model.id                                    // Record ID
model.update(changes)                       // Update this record
model.delete()                              // Delete this record
model.toJSON()                              // Return plain object
// + direct property access to all fields via Proxy
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

**Field options:**

| Option | Type | Description |
|---|---|---|
| `type` | `"string" \| "number" \| "boolean" \| "object" \| "array"` | Field data type |
| `required` | `boolean` | Field must be provided |
| `default` | `unknown` | Default value if not provided |
| `validate` | `"email" \| "url" \| RegExp \| function` | Format validation |
| `min` | `number` | Minimum value (number fields) |
| `max` | `number` | Maximum value (number fields) |
| `maxLength` | `number` | Maximum string length |
| `items` | `FieldDefinition` | Item type for arrays |
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

### FTS Plugin

Full-text search with inverted indexing:

```typescript
// Schema marks searchable fields
const schema = {
  collections: {
    articles: {
      fields: { title: { type: "string" }, body: { type: "string" } },
      searchable: ["title", "body"],  // <-- These fields are indexed
    },
  },
}

// Use search() in queries
const results = await articles.query().search("title", "typescript").fetch()
```

Features: tokenization, stop-word removal, case-insensitive, multi-field, automatic index updates on create/update/delete.

### Relations Plugin

Lazy-loaded relation getters (built into Model) + eager loading:

```typescript
// Schema defines relations
relations: {
  author: { type: "belongs_to", collection: "users", foreignKey: "userId" },
  comments: { type: "has_many", collection: "comments", foreignKey: "postId" },
}

// Lazy access (built-in, no plugin needed)
const author = await (await post.author).first()

// Eager loading (requires relationsPlugin)
const posts = await postsCol.query().fetch()  // relations attached via plugin
```

### Validation Plugin

Extensible validation with custom rules:

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

Built-in rules: email format, URL format, noEmptyStrings.

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
  const todos = useQuery("todos", (q) => q.sort({ createdAt: "desc" }))
  const { create, delete: remove } = useMutation("todos")

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
| `useQuery<T>(name, queryFn?, deps?)` | `(Model<T> & T)[]` | Reactive query, re-fetches on changes |
| `useDoc<T>(name, id)` | `(Model<T> & T) \| undefined` | Single document by ID |
| `useMutation<T>(name)` | `{ create, update, delete, loading, error, reset }` | CRUD with loading/error state |

---

## Examples

| Example | Location | Description |
|---|---|---|
| CDN Todo App | [`examples/cdn/index.html`](examples/cdn/index.html) | Browser todo app via `<script>` tag |
| Node.js CLI | [`examples/node/index.mjs`](examples/node/index.mjs) | CRUD, queries, FTS in Node.js |
| React Integration | [`tests/unit/react.test.tsx`](tests/unit/react.test.tsx) | Hook API usage patterns |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│            User Code / Framework             │
├─────────────────────────────────────────────┤
│    Database       Collection     Plugin API  │
├─────────────────────────────────────────────┤
│    QueryBuilder   QueryPlanner              │
│    QueryExecutor  Schema/Model              │
├─────────────────────────────────────────────┤
│    MemoryAdapter  IndexedDBAdapter          │
│    (Node/testing) (production browser)      │
├─────────────────────────────────────────────┤
│    Reactivity System (Signal-based)         │
└─────────────────────────────────────────────┘
```

### Project Structure

```
src/
├── adapter/          # Storage adapters (Memory, IndexedDB)
├── model/            # Proxy-based record wrapper
├── plugins/          # FTS, Relations, Validation plugins
├── query/            # Query engine (builder, planner, executor)
├── reactive/         # Signal reactivity system
├── utils/            # Plugin hook runner
├── collection.ts     # Collection CRUD + change events
├── database.ts       # Database entry point
├── errors.ts         # Error classes
├── index.ts          # Public API barrel exports
├── react.ts          # React hooks (useQuery, useDoc, useMutation)
├── schema.ts         # Schema definition and validation
└── types.ts          # Core TypeScript interfaces
tests/
├── unit/             # Unit tests (8 files, 173 tests)
├── benchmarks/       # Performance benchmarks (WIP)
└── integration/      # Cross-component tests (WIP)
examples/
├── cdn/              # Browser CDN example
└── node/             # Node.js CLI example
```

---

## Development

```bash
git clone https://github.com/ctrotech-tutor/ctrodb.git
cd ctrodb
npm install

npm run dev           # Watch mode
npm test              # Run tests (173 tests)
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
| `npm run build` | Build all output formats |
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
  <a href="https://github.com/ctrotech-tutor/ctrodb/issues">Issues</a>
</p>
