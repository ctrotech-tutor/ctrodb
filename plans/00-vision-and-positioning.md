# Plan 00 — Vision & Positioning

## The Problem

Building client-side apps that need persistent, structured data is unnecessarily hard:

- **localStorage** is synchronous, blocking, has no queries, no indexes, 5MB limit
- **IndexedDB** is powerful but its raw API is verbose, callback-based, and error-prone
- **Dexie.js** is mature but imperative, has no built-in reactivity or FTS
- **RxDB** is powerful but 100KB+, complex, heavyweight
- **Firebase** requires network, creates lock-in, and is overkill for local-first apps

Developers shouldn't have to choose between "easy but limited" and "powerful but painful."

## The Solution

CtroDB v3 is a **zero-dependency, reactive, client-side database** that makes IndexedDB feel like a modern ORM. It provides:

- Schema-driven data modeling with runtime validation
- A fluent, chainable query API with an index-aware query planner
- Built-in reactivity via signals (no manual state management)
- Full-text search with an inverted index engine
- Model relations (has_many, belongs_to, has_one)
- Transactions with atomicity guarantees
- Framework bindings for React, Vue, Svelte, and Solid
- CDN/script tag support for junior developers

All in ~5KB gzipped with zero dependencies.

## Target Audience

### Primary

1. **React/Vue/Solid devs** building SPAs with client-side persistence
   - They want their database to be reactive by default
   - They don't want to manage separate state when the source of truth is IndexedDB
   - They appreciate TypeScript end-to-end

2. **Junior/solo devs** who need a database but find the ecosystem intimidating
   - They can use it via CDN with zero build setup
   - The API is intuitive and doesn't require deep database knowledge

3. **Agency devs** building internal tools, dashboards, and client apps
   - They need FTS, relations, and reactive queries without Firebase complexity
   - Bundle size matters for performance-sensitive client projects

### Secondary

4. **PWA / offline-first app developers**
   - Who need reliable local storage that syncs with their UI
   - Who don't want the complexity of RxDB for apps that don't need replication

5. **Prototype builders**
   - Who need to go from idea to working app in minutes
   - Who can use the CDN build for quick prototypes

## Competitive Analysis

### Dexie.js — The 800lb Gorilla

**Strengths:**
- 10+ years battle-tested
- Excellent documentation
- Large community
- Dexie Cloud for sync
- Known and trusted

**Weaknesses:**
- Imperative API (call `.toArray()`, iterate manually)
- Reactivity is bolted on via `liveQuery()` + Observable
- No built-in full-text search
- No built-in model relations
- TypeScript support is good but not first-class (no generics on collections)
- ~20KB gzipped
- Browser-focused with limited Node.js support

### RxDB — The Reactive Powerhouse

**Strengths:**
- Built-in replication, encryption, schema validation
- Full TypeScript support
- Observable-based reactivity
- Runs on Node, Browser, React Native

**Weaknesses:**
- ~100KB+ gzipped
- ~20 dependencies
- Steep learning curve
- Overkill for apps that don't need replication
- Schema system is MongoDB-like, not SQL/ORM-like

### PouchDB — The CouchDB Protocol Client

**Strengths:**
- Battle-tested replication
- Cross-platform
- Mature

**Weaknesses:**
- Complex API
- Heavy
- No schema
- CouchDB-specific protocol (vendor lock-in)

### localForage — The Async localStorage

**Strengths:**
- Simple API
- Cross-browser
- Small

**Weaknesses:**
- Key-value only (no queries, no schema, no relations)
- Not suitable for structured data applications

### LokiJS — The In-Memory DB

**Strengths:**
- Fast queries on in-memory data
- MongoDB-like API

**Weaknesses:**
- In-memory (not truly persistent for browser apps)
- Persistence via adapter (serialization overhead)
- No built-in reactivity

## Positioning Statement

> **"CtroDB is the Prisma of client-side databases."**

Just as Prisma made SQL a joy with its schema-driven, type-safe approach, CtroDB does the same for IndexedDB. It's the database wrapper you'd design if you were building it today for today's frameworks and developer expectations.

## Key Differentiators

1. **Signal-based reactivity built-in, not bolted on**
   - Dexie: manual `.toArray()` or `liveQuery()` Observable
   - RxDB: Observable-based
   - **CtroDB: signals integrate directly into React/Vue/Solid state**

2. **Zero runtime dependencies**
   - Dexie: 1 dep
   - RxDB: ~20 deps
   - **CtroDB: 0 deps**

3. **FTS + Relations out of the box**
   - Dexie: no FTS, relations via addon
   - RxDB: no built-in FTS
   - **CtroDB: both FTS and relations are built-in plugins**

4. **Index-aware query planner**
   - Most wrappers forward queries to IDB without optimization
   - **CtroDB: analyzes conditions, picks best index, builds IDBKeyRange**

5. **CDN-first for junior devs**
   - Most libraries assume a build tool
   - **CtroDB: UMD build works in any HTML page with one `<script>` tag**

6. **TypeScript-first, not TypeScript-ported**
   - Full generics on Database, Collection, Query, Model
   - End-to-end type safety from schema definition to query results

## The Pitch

> "Stop fighting IndexedDB's raw API or settling for localStorage's limits. CtroDB gives you a typed, reactive, relational database with full-text search — in 5KB, zero dependencies, usable from a CDN. Your data layer should be this easy."
