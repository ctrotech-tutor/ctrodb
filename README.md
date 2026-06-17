<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="">
    <img alt="ctrodb" src="" width="400">
  </picture>
</p>

<h1 align="center">ctrodb</h1>

<p align="center">
  <strong>Zero-dependency, reactive, client-side database for the browser and Node.js</strong>
</p>

<p align="center">
  <a href="#installation">Installation</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0--alpha.4-blue" alt="version">
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="zero dependencies">
  <img src="https://img.shields.io/badge/build-tsup-red" alt="build">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

---

## Overview

**ctrodb** is a reactive, client-side database built from scratch with zero runtime dependencies. It provides a MongoDB-like API with full TypeScript support, IndexedDB persistence, Signal-based reactivity, and a plugin system for extensibility.

Designed for modern web applications that need local-first data management without the overhead of large frameworks or external libraries.

### Key Features

- **Zero Dependencies** — No external runtime libraries. Not even a single one.
- **Reactive** — Built-in Signal system for automatic UI updates.
- **Framework-Agnostic** — Works with vanilla JS, React, Vue, Svelte, or any framework.
- **TypeScript First** — Full type safety with generics, strict types, and exhaustive type exports.
- **Flexible Storage** — Memory adapter for testing/Node.js, IndexedDB for production browsers.
- **Query Engine** — Fluent query builder with index-aware planning and optimization.
- **Schema Validation** — Declarative schemas with type checking, defaults, and format validation.
- **Plugin System** — Extensible via hooks for full-text search, relations, validation, and more.
- **Universal Module** — ESM, CJS, and IIFE (CDN-ready) builds.

---

## Installation

```bash
npm install ctrodb
```

### CDN (script tag)

```html
<script src="https://unpkg.com/ctrodb@latest/dist/index.global.js"></script>
<script>
  const db = new ctrodb.Database("my-app");
</script>
```

---

## Quick Start

### Basic Usage

```typescript
import { Database } from "ctrodb"

// Define your schema
const schema = {
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string", required: true },
        email: { type: "string", validate: "email" },
        age: { type: "number", min: 0, max: 150 },
      },
      indexes: [{ field: "email", unique: true }],
    },
  },
}

// Create a database
const db = new Database("my-app", { schema })

// Insert a document
const user = await db.collection("users").create({
  name: "Alice",
  email: "alice@example.com",
  age: 30,
})

// Query with chaining
const results = await db
  .collection("users")
  .query()
  .where("age", ">=", 18)
  .where("age", "<=", 65)
  .sort({ name: "asc" })
  .fetch()

// React to changes
const unsubscribe = db.collection("users").onChange((event) => {
  console.log("Change:", event.type, event.recordId)
})
```

### Model Access

```typescript
const models = await db.collection("users").query().fetch()

// Direct property access via Proxy
console.log(models[0].name) // "Alice"
console.log(models[0].email) // "alice@example.com"

// Update through the model
await models[0].update({ age: 31 })
```

---

## Documentation

Full documentation is available at **[ctrodb.vercel.app](https://ctrodb.vercel.app)**.

- [Getting Started](https://ctrodb.vercel.app/docs/getting-started)
- [API Reference](https://ctrodb.vercel.app/docs/api)
- [Schema Design](https://ctrodb.vercel.app/docs/schema)
- [Query Engine](https://ctrodb.vercel.app/docs/queries)
- [Storage Adapters](https://ctrodb.vercel.app/docs/storage)
- [Plugins](https://ctrodb.vercel.app/docs/plugins)
- [React Integration](https://ctrodb.vercel.app/docs/react)

---

## Architecture

```
┌─────────────────────────────────────────────┐
│              User Code / Framework           │
├─────────────────────────────────────────────┤
│    Collection     Database     Plugin API    │
├─────────────────────────────────────────────┤
│       QueryBuilder   QueryPlanner           │
│       QueryExecutor  Schema/Model           │
├─────────────────────────────────────────────┤
│    MemoryAdapter     IndexedDBAdapter       │
│    (testing/Node)     (production browser)  │
├─────────────────────────────────────────────┤
│     Reactivity System (Signal-based)        │
└─────────────────────────────────────────────┘
```

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development

```bash
git clone https://github.com/ctrotech-tutor/ctrodb.git
cd ctrodb
npm install
npm run dev    # TypeScript watch mode
npm test       # Run tests
npm run build  # Build all formats
```

### Project Structure

```
src/
├── adapter/        # Storage adapters (Memory, IndexedDB)
├── model/          # Model class (Proxy-based record wrapper)
├── query/          # Query engine (builder, planner, executor)
├── reactive/       # Reactivity system (Signal)
├── errors.ts       # Error classes
├── index.ts        # Public API barrel exports
├── schema.ts       # Schema definition and validation
└── types.ts        # Core TypeScript interfaces
tests/
├── setup.ts        # Test environment (fake-indexeddb)
└── unit/           # Unit tests
```

---

## Security

Report security vulnerabilities to **[security@ctrodb.dev](mailto:security@ctrodb.dev)** or see [SECURITY.md](SECURITY.md).

---

## License

[MIT](LICENSE) © 2026 Ctrotech Tutor

---

<p align="center">
  <a href="https://ctrodb.vercel.app">ctrodb.vercel.app</a> •
  <a href="https://github.com/ctrotech-tutor/ctrodb">GitHub</a>
</p>
