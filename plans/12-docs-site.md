# Docs Site Plan — ctrodb

## Overview

Build a professional documentation site for ctrodb using **Next.js + Fumadocs**, deployed to **ctrodb.vercel.app** (already configured in GitHub repo settings).

---

## 1. Framework Choice: Fumadocs

### Why Fumadocs over alternatives

| Factor | Fumadocs | Nextra | Docusaurus |
|--------|----------|--------|------------|
| **TypeScript type docs** | ✅ Built-in (`auto-type-table`) | ❌ | ❌ (via plugin) |
| **Customizability** | ✅ Full React control | ⚠️ Limited | ⚠️ Config-driven |
| **RSC / Live examples** | ✅ Yes | ✅ Yes | ❌ |
| **Search** | ✅ Orama (default) | ✅ FlexSearch | ✅ Algolia |
| **Integration with Next.js** | ✅ Native | ✅ Plugin | ❌ Standalone |
| **Versioning** | ❌ Manual | ❌ Manual | ✅ Native |
| **OpenAPI** | ✅ Built-in | ❌ | Via plugin |
| **i18n** | ✅ Yes | ✅ Yes | ✅ Native |
| **Bundle size / perf** | ✅ Excellent | ✅ Excellent | ⚠️ Heavier |
| **Ecosystem maturity** | ⚠️ Smaller | ✅ Good | ✅ Largest |

**Verdict**: Fumadocs wins for ctrodb because:
- **TypeScript type documentation generation** is critical — we have 49 exported symbols with complex types. Manually writing all type docs is error-prone. Fumadocs can auto-generate type tables from source.
- **Full customization** — we want the docs site to feel like a premium product, not a generic template.
- **RSC for live examples** — we can embed live interactive code playgrounds that run ctrodb in the browser.
- **Already in Next.js ecosystem** — leverages our existing TypeScript/React expertise.

---

## 2. Site Architecture

```
ctrodb-docs/                    # Separate repo or monorepo package
├── content/
│   ├── docs/
│   │   ├── index.mdx           # Overview / landing
│   │   ├── getting-started/
│   │   │   ├── installation.mdx
│   │   │   ├── quick-start.mdx
│   │   │   └── cdn-usage.mdx
│   │   ├── core-concepts/
│   │   │   ├── database.mdx
│   │   │   ├── schema.mdx
│   │   │   ├── collection.mdx
│   │   │   ├── model.mdx
│   │   │   └── query-engine.mdx
│   │   ├── adapters/
│   │   │   ├── overview.mdx
│   │   │   ├── memory-adapter.mdx
│   │   │   └── indexeddb-adapter.mdx
│   │   ├── plugins/
│   │   │   ├── overview.mdx
│   │   │   ├── full-text-search.mdx
│   │   │   ├── relations.mdx
│   │   │   ├── validation.mdx
│   │   │   └── custom-plugins.mdx
│   │   ├── react/
│   │   │   ├── setup.mdx
│   │   │   ├── use-query.mdx
│   │   │   ├── use-doc.mdx
│   │   │   ├── use-mutation.mdx
│   │   │   └── database-provider.mdx
│   │   ├── api-reference/
│   │   │   ├── database.md        # Auto-generated from TypeScript
│   │   │   ├── collection.md
│   │   │   ├── schema.md
│   │   │   ├── model.md
│   │   │   ├── query-builder.md
│   │   │   ├── signal.md
│   │   │   ├── errors.md
│   │   │   ├── memory-adapter.md
│   │   │   ├── indexeddb-adapter.md
│   │   │   ├── fts-indexer.md
│   │   │   ├── relations-engine.md
│   │   │   ├── validation-engine.md
│   │   │   └── types.md
│   │   ├── examples/
│   │   │   ├── cdn-todo.mdx
│   │   │   ├── node-cli.mdx
│   │   │   └── react-spa.mdx
│   │   ├── migration/
│   │   │   └── from-alpha.mdx
│   │   └── contributing.mdx
│   └── meta.json             # Sidebar navigation structure
├── public/
│   ├── og-image.png
│   └── logo.svg
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx              # Landing page
│   │   ├── docs/
│   │   │   ├── layout.tsx        # Docs layout with sidebar
│   │   │   └── [[...slug]]/
│   │   │       └── page.tsx      # Catch-all MDX route
│   │   └── api/
│   │       └── search/route.ts   # Search API endpoint
│   ├── components/
│   │   ├── playground.tsx        # Live ctrodb code playground
│   │   ├── quick-start.tsx       # Interactive quick start component
│   │   └── version-badge.tsx     # Version display
│   └── lib/
│       └── source.ts             # Fumadocs content source config
├── package.json
├── tsconfig.json
├── next.config.ts
├── fumadocs.config.ts
└── vercel.json
```

---

## 3. Content Structure & Pages

### 3.1 Landing Page (`content/index.mdx`)
- Hero with ctrodb logo + tagline
- Key features grid (zero-dependency, reactive, schema-driven, plugins, React bindings, CDN-ready)
- Quick install command copyable
- "Get Started" CTA button
- Stats: 190+ tests, zero deps, 25KB gzip
- npm version badge + CI status badge

### 3.2 Getting Started

#### Installation (`content/docs/getting-started/installation.mdx`)
```mdx
import { Tabs, Tab, NpmCommands } from "fumadocs-ui/components/tabs"

## Installation

<NpmCommands package="ctrodb" />

## Requirements

- Node.js 20+ (for development tooling)
- The library itself works in any modern browser or Node 20+
```

#### Quick Start (`content/docs/getting-started/quick-start.mdx`)
- Step-by-step guide to create a Database, define a schema, connect, CRUD
- Each step has a live editable code example
- End result: a working todo list

#### CDN Usage (`content/docs/getting-started/cdn-usage.mdx`)
- Script tag approach
- Link to examples/cdn/index.html
- IIFE global name: `CtroDB`
- Unpkg URL: `https://unpkg.com/ctrodb@latest/dist/index.global.js`

### 3.3 Core Concepts

#### Database (`content/docs/core-concepts/database.mdx`)
- What is a Database?
- Configuration options (name, adapter, schema, plugins, logLevel)
- Connect / Disconnect lifecycle
- Transaction support
- Change events (`.on()`)
- `isConnected` / `adapterName` getters

#### Schema (`content/docs/core-concepts/schema.mdx`)
- What is a Schema?
- Collection definitions
- Field types and options (type, required, default, min/max, maxLength)
- Indexes (unique, single-field)
- Searchable fields
- Relations (per-collection)
- Schema validation

Full field options table:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `type` | `"string" \| "number" \| "boolean" \| "object" \| "array"` | — | Data type |
| `required` | `boolean` | `false` | Must be present |
| `default` | `unknown \| (() => unknown)` | — | Default value |
| `min` | `number` | — | Min value (number) |
| `max` | `number` | — | Max value (number) |
| `maxLength` | `number` | — | Max string length |
| `items` | `FieldDefinition` | — | Array item type |
| `unique` | `boolean` | `false` | Unique constraint (via index) |

#### Collection (`content/docs/core-concepts/collection.mdx`)
- CRUD operations: `create`, `get`, `getAll`, `update`, `delete`, `deleteMany`
- Upsert with `put()`
- Count with `count()`
- Query builder access with `query()`
- Change subscriptions with `onChange()`
- Each operation with code example

#### Model (`content/docs/core-concepts/model.mdx`)
- Proxy-based transparent field access: `user.name` instead of `user.get("name")`
- Instance methods: `.update()`, `.delete()`, `.toJSON()`
- Relation getter auto-attachment

#### Query Engine (`content/docs/core-concepts/query-engine.mdx`)
- QueryBuilder fluent API: `where`, `orWhere`, `sort`, `limit`, `offset`, `search`
- Terminal operations: `fetch`, `first`, `count`, `toArray`
- QueryPlanner strategy selection (index_scan, full_scan, id_lookup)
- QueryExecutor pipeline (filter, sort, limit, offset)
- Search conditions vs where conditions

### 3.4 Adapters

#### Overview (`content/docs/adapters/overview.mdx`)
- What is a StorageAdapter?
- Built-in adapters: Memory, IndexedDB
- Auto-detection with `createAdapter()`
- Custom adapter interface
- Transaction context

#### MemoryAdapter (`content/docs/adapters/memory-adapter.mdx`)
- In-memory Map-based storage
- Auto-increment numeric IDs
- Perfect for Node.js, testing, and demos
- Labelled "not persisted across sessions"

#### IndexedDBAdapter (`content/docs/adapters/indexeddb-adapter.mdx`)
- Browser IndexedDB-backed storage
- Auto-increment IDs via IDB keyPath
- Schema migration via `onupgradeneeded`
- Shared-transaction rollback via stored procedures
- Labelled "persists in browser, not available in Node"

### 3.5 Plugins

#### Overview (`content/docs/plugins/overview.mdx`)
- What are plugins?
- Lifecycle hooks (onDatabaseInit, onCollectionInit, before/after create/update/delete)
- Hook execution order
- Plugin interface reference
- Built-in plugins: FTS, Relations, Validation

#### Full-Text Search (`content/docs/plugins/full-text-search.mdx`)
- `ftsPlugin()` setup
- `searchable` field configuration in schema
- `query().search(field, term)` usage
- Tokenizer behavior (lowercase, stop words, dedup)
- Index maintenance (auto on create/update/delete)
- `FTSIndexer` API for advanced use
- `tokenize()` utility

#### Relations (`content/docs/plugins/relations.mdx`)
- `relationsPlugin()` setup
- Relation types: `belongs_to`, `has_many`, `has_one`
- Per-collection relation config
- Eager loading with `.with("relationName")`
- `RelationsEngine` API for advanced use

#### Validation (`content/docs/plugins/validation.mdx`)
- `validationPlugin()` with custom rules
- `ValidationRule` interface
- Built-in rules: `email`, `url`, `noEmptyStrings`
- `ValidationEngine` API
- Error handling: catches on create/update, throws descriptive errors

#### Custom Plugins (`content/docs/plugins/custom-plugins.mdx`)
- Full `CtroDBPlugin` interface reference
- Step-by-step: logging plugin, audit plugin, encryption plugin
- Hook return value semantics (return data to modify in beforeCreate/beforeUpdate)

### 3.6 React Bindings

#### Setup (`content/docs/react/setup.mdx`)
- Install `ctrodb` (React bindings are included, no extra package)
- Import from `ctrodb/react`
- Wrap app with `DatabaseProvider`
- `setDefaultDatabase()` for non-context usage

#### useQuery (`content/docs/react/use-query.mdx`)
- Signature: `useQuery<T>(collectionName, queryFn?, deps?)`
- Reactive: re-renders on change events for the collection
- Query function: filter, sort, limit, search
- Dependency array for dynamic queries
- Type-safe generics

#### useDoc (`content/docs/react/use-doc.mdx`)
- Signature: `useDoc<T>(collectionName, id)`
- Returns single document or undefined
- Wraps useQuery under the hood

#### useMutation (`content/docs/react/use-mutation.mdx`)
- Signature: `useMutation<T>(collectionName)`
- Returns `{ create, update, delete, loading, error, reset }`
- Loading/error state management
- Example: form submission with loading indicator

#### DatabaseProvider (`content/docs/react/database-provider.mdx`)
- Context provider for database instance
- Also calls `setDefaultDatabase()` automatically
- `useDatabase()` hook for accessing db instance from context

### 3.7 API Reference

Auto-generated from TypeScript source using Fumadocs `auto-type-table`. Each page documents:
- Class/interface overview
- Constructor signature
- All methods with signatures and descriptions
- Parameter tables
- Return types
- Example usage

Pages:
- `Database`
- `Collection`
- `Schema`
- `Model`
- `QueryBuilder`
- `QueryPlanner`
- `QueryExecutor`
- `Signal`
- `MemoryAdapter`
- `IndexedDBAdapter`
- `StorageAdapter`
- `FTSIndexer`
- `RelationsEngine`
- `ValidationEngine`
- `CtroDBPlugin`
- Error classes (`CtrodbError`, `ConnectionError`, etc.)
- Type reference (`ID`, `FieldDefinition`, `SchemaConfig`, etc.)

### 3.8 Examples

#### CDN Todo (`content/docs/examples/cdn-todo.mdx`)
- Link to `examples/cdn/index.html`
- Explain the code inline with annotations
- Demo GIF or screenshot

#### Node.js CLI (`content/docs/examples/node-cli.mdx`)
- Link to `examples/node/index.mjs`
- Explain CRUD + FTS workflow
- Run instructions

#### React SPA (`content/docs/examples/react-spa.mdx`)
- Link to `examples/react/`
- Explain each feature: Todos, Search, Relations
- Run instructions: `cd examples/react && npm install && npm run dev`

### 3.9 Migration Guide (`content/docs/migration/from-alpha.mdx`)
- Changes from alpha.1 → alpha.6 → v1.0.0
- SchemaConfig now requires `version: 1`
- Plugin API changes
- Breaking changes list

### 3.10 Contributing (`content/docs/contributing.mdx`)
- Link to CONTRIBUTING.md
- Development setup
- Running tests
- Code style
- PR process

---

## 4. Technical Implementation

### 4.1 Project Setup

```bash
npm create fumadocs-app
# Framework: Next.js
# Content: Fumadocs MDX
# Name: ctrodb-docs
```

### 4.2 Key Packages

```json
{
  "dependencies": {
    "next": "^15.0.0",
    "fumadocs-ui": "^14.0.0",
    "fumadocs-core": "^14.0.0",
    "fumadocs-mdx": "^14.0.0",
    "ctrodb": "latest"
  },
  "devDependencies": {
    "@fumadocs/cli": "^14.0.0",
    "typescript": "^5.6.0"
  }
}
```

### 4.3 Content Source Configuration

`src/lib/source.ts`:
```ts
import { docs, blog, meta } from "@/.source"
import { createMDXSource } from "fumadocs-mdx"
import { loader } from "fumadocs-core/source"

export const { getPage, getPages, pageTree } = loader({
  baseUrl: "/docs",
  source: createMDXSource(docs, meta),
})
```

### 4.4 Docs Layout

`src/app/docs/layout.tsx` — Fumadocs DocsLayout with:
- Sidebar navigation from page tree
- Search bar (built-in)
- Table of contents (from headings)
- Breadcrumbs
- Edit on GitHub link
- Last updated date
- Light/dark mode toggle

### 4.5 Interactive Components

#### Playground (`src/components/playground.tsx`)
Live ctrodb code editor using a simple textarea + output div approach:
- User types code
- Code is evaluated against a sandboxed ctrodb instance
- Output shown below
- Reset button to clear state

Alternatively, use an existing code sandbox component or `@fumadocs/ui` code block enhancements.

#### Quick Start Step-through
An interactive component that guides users through:
1. Creating a database
2. Defining a collection
3. Inserting data
4. Querying data
5. Updating data
6. Deleting data

Each step has a "Run" button that executes the code and shows the result.

### 4.6 Styling & Theming

- **Primary color**: Blue (#0070f3) to match npm/React ecosystem
- **Typography**: Inter / system font stack
- **Dark mode**: Fumadocs default with custom accent color
- **Logo**: ctrodb wordmark + minimal icon
- **Landing page**: Custom hero section, not default Fumadocs landing
- **Custom components**: Cards, Steps, Callouts, Tabs via Fumadocs built-in

### 4.7 SEO & Metadata

- Dynamic OG images per page (Fumadocs `dynamic-og` support)
- `generateMetadata` for each doc page with title/description
- `sitemap.xml` generation
- `robots.txt`
- structured data for docs (JSON-LD)

### 4.8 Search

Fumadocs ships with built-in Orama full-text search. Configuration:
- Indexes all MDX content
- Client-side search UI
- Keyboard shortcut (Cmd+K)
- Server-side search endpoint for larger indexes

### 4.9 Deployment

In `vercel.json`:
```json
{
  "framework": "nextjs",
  "installCommand": "npm install",
  "buildCommand": "npm run build",
  "outputDirectory": ".next"
}
```

Deploy via Vercel Git integration (already configured pointing to `ctrodb.vercel.app`).

---

## 5. Implementation Phases

### Phase 1: Scaffold & Layout (estimated: 1 session)
- Create fumadocs app via CLI
- Configure sidebar navigation structure
- Set up doc layout with search
- Configure theming (colors, logo)
- Deploy blank site to Vercel to verify pipeline

### Phase 2: Core Content (estimated: 2 sessions)
- Getting Started (installation, quick start, CDN)
- Core Concepts (Database, Schema, Collection, Model, Query Engine)
- Each page includes: explanation, code examples, edge cases

### Phase 3: Plugins & React (estimated: 2 sessions)
- Plugin overview + 3 plugin guides
- React bindings (5 pages)
- Custom plugins guide

### Phase 4: API Reference (estimated: 1 session)
- Set up `auto-type-table` for TypeScript type generation
- Create API reference pages for all classes
- Create types reference

### Phase 5: Interactive Features (estimated: 2 sessions)
- Build live playground component
- Build interactive quick start
- Add code example copy buttons
- Embed examples (CDN, Node, React) with explainers

### Phase 6: Polish & Launch (estimated: 1 session)
- Landing page hero
- SEO metadata
- OG images
- Edit on GitHub links
- Last updated dates
- Link validation (CI check for broken links)
- Final review and publish

---

## 6. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Separate repo or in monorepo?** | **Separate repo** (`ctrodb-docs`) | Avoids inflating the main package. Docs site has different deps (Next.js, React 19, Fumadocs). |
| **MDX files location** | `content/docs/` | Fumadocs convention |
| **Auto-generate API docs or manual?** | **Auto-generate** with type tables + manual descriptions | Auto-type-table handles signatures, we add prose explanations |
| **Live examples** | Custom React components | Lightweight, no need for iframes or external services |
| **Versioned docs** | Manual (subfolder per version) | Not needed until v2.0.0. For now, docs track latest |
| **i18n** | English only (for now) | Add later if needed |
| **Search** | Built-in Orama | Zero setup, works out of box |
| **Analytics** | None initially | Add Umami/Plausible later if desired |
| **CI for broken links** | Add to GitHub Actions | Run `fumadocs check-links` in CI |

---

## 7. Future Enhancements

- **Versioned docs**: `/docs/v1.0/`, `/docs/v2.0/` when major versions release
- **Interactive API playground**: Full Monaco editor with ctrodb in Web Workers
- **Integration with GitHub**: Sync release notes from CHANGELOG.md automatically
- **Blog**: Changelog posts, tutorials, case studies
- **Multi-language**: i18n support for international users
- **Video tutorials**: Embedded walkthroughs

---

## 8. Estimated Effort

| Phase | Pages | Tasks | Estimated Time |
|-------|-------|-------|----------------|
| 1. Scaffold | 0 | CLI, layout, config, deploy | 30 min |
| 2. Core Content | 8–10 | Write MDX, code examples | 3 hrs |
| 3. Plugins & React | 8–10 | Write MDX, code examples | 3 hrs |
| 4. API Reference | 15–18 | Auto-generate, add descriptions | 2 hrs |
| 5. Interactive Features | 2–3 | Build playground, quick-start component | 3 hrs |
| 6. Polish & Launch | 1 | SEO, OG images, review | 1 hr |
| **Total** | **~35 pages** | **~13 hrs** | |

---

## 9. Review Checklist

Before launch, verify:

- [ ] All pages render without errors
- [ ] Search works and indexes all content
- [ ] Light/dark mode works on all pages
- [ ] Mobile responsive (sidebar collapse, font sizes)
- [ ] Code examples are correct and runnable
- [ ] All links work (internal + external)
- [ ] OG images render on social share
- [ ] Google Lighthouse score > 90
- [ ] `sitemap.xml` includes all pages
- [ ] `robots.txt` configured
- [ ] 404 page styled
- [ ] Edit on GitHub links resolve correctly
- [ ] Deployed on Vercel with custom domain
