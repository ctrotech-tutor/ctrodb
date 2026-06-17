# Plan 10 — Workspace Setup

## Phase 1: Clean Existing Repo

Delete all existing source code, examples, and build artifacts. Keep only `.git/` and `.github/`.

### Files to Delete

```bash
# Remove old source
Remove-Item -Recurse -Force src/
Remove-Item -Recurse -Force example/
Remove-Item -Recurse -Force dist/          # if exists

# Remove old config files
Remove-Item -Force package.json
Remove-Item -Force package-lock.json
Remove-Item -Force rollup.config.js
Remove-Item -Force README.md
Remove-Item -Force .gitignore
Remove-Item -Force .npmignore
Remove-Item -Force LICENSE

# Keep
# .git/
# .github/workflows/
# plans/  (the plans we just wrote)
```

### Verify Clean State

```bash
git status
# Should show only: plans/ (new directory), .github/ (untouched)
```

---

## Phase 2: Initialize New Project

### Create Root Files

#### package.json

```json
{
  "name": "ctrodb",
  "version": "3.0.0-alpha.1",
  "private": true,
  "description": "A zero-dependency, reactive, client-side database with full-text search and relations. Schema-driven, type-safe, and a joy to use.",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "unpkg": "dist/index.iife.js",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./react": {
      "import": {
        "types": "./dist/react.d.mts",
        "default": "./dist/react.mjs"
      },
      "require": {
        "types": "./dist/react.d.cts",
        "default": "./dist/react.cjs"
      }
    }
  },
  "files": [
    "dist",
    "src",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "bench": "vitest bench",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "lint:fix": "biome check --apply src/",
    "format": "biome format --write src/",
    "prepublishOnly": "npm run build && npm test"
  },
  "keywords": [
    "ctrodb",
    "indexeddb",
    "database",
    "reactive",
    "client-side",
    "offline-first",
    "full-text-search",
    "typescript",
    "zero-dependency"
  ],
  "author": "Ctrotech",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ctrotech-tutor/ctrodb.git"
  },
  "bugs": {
    "url": "https://github.com/ctrotech-tutor/ctrodb/issues"
  },
  "homepage": "https://github.com/ctrotech-tutor/ctrodb#readme",
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.3.0",
    "vitest": "^3.0.0",
    "@biomejs/biome": "^1.9.0",
    "fake-indexeddb": "^6.0.0",
    "@types/node": "^22.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

Note: `fake-indexeddb` is a devDependency for testing. Zero runtime dependencies.

#### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,

    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",

    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

#### tsup.config.ts

```typescript
import { defineConfig } from 'tsup';

export default defineConfig([
  // Core library
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs', 'iife'],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    globalName: 'CtroDB',
    outExtension({ format }) {
      return {
        esm: '.mjs',
        cjs: '.cjs',
        iife: '.iife.js',
      }[format] || '.js';
    },
  },
  // React bindings (separate entry)
  {
    entry: ['src/bindings/react.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    minify: true,
    external: ['react'],
    outDir: 'dist',
    outExtension({ format }) {
      return {
        esm: '.mjs',
        cjs: '.cjs',
      }[format] || '.js';
    },
  },
]);
```

#### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
```

#### .gitignore

```
node_modules/
dist/
coverage/
*.tsbuildinfo
.DS_Store
Thumbs.db
```

#### .npmignore

```
tests/
docs/
plans/
coverage/
src/
tsconfig.json
tsup.config.ts
vitest.config.ts
biome.json
```

#### biome.json

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "warn",
        "useConst": "error"
      },
      "correctness": {
        "noUnusedVariables": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "es5",
      "semicolons": "always"
    }
  }
}
```

#### .github/workflows/ci.yml

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test -- --run
      - run: npm run build
```

#### tests/setup.ts

```typescript
import 'fake-indexeddb/auto';

// Global test setup
// This automatically mocks IndexedDB for all tests
// No additional configuration needed
```

---

## Phase 3: Create Source Directory Structure

```bash
mkdir -p src
mkdir -p src/model
mkdir -p src/query
mkdir -p src/reactive
mkdir -p src/adapter/idb
mkdir -p src/plugins/fts
mkdir -p src/bindings
mkdir -p tests/unit
mkdir -p tests/integration
mkdir -p tests/benchmarks
mkdir -p docs
mkdir -p examples/cdn-todo
mkdir -p examples/react-todo
mkdir -p examples/kanban
```

### Create Stub Source Files

Each source file should start with a minimal stub that just exports its class/function for TypeScript resolution. We'll fill them during the implementation phase.

```typescript
// src/types.ts
export type ID = number | string;
// ... full types added during implementation

// src/index.ts
export { Database } from './database';
// ... all public exports added during implementation

// src/database.ts
export class Database {
  constructor() { /* stub */ }
}

// etc for all files
```

---

## Phase 4: Install Dependencies & Verify

```bash
npm install
npm run typecheck    # Should pass (empty types)
npm run lint         # Should pass
npm run build        # Should generate dist/
npm test             # Should pass (no tests yet, but vitest should run)
```

---

## Phase 5: Initial Commit

```bash
git add .
git commit -m "chore: initialize v3 workspace with TypeScript, tsup, Vitest, Biome"
git tag v3.0.0-alpha.0
```

---

## Phase 6: Delete Old npm Package

```bash
# Navigate to npm website or use CLI
npm owner rm ctrodb <current-owner-email>
npm unpublish ctrodb@2.0.0 --force
# OR if removing all versions:
npm unpublish ctrodb --force
```

After this, the name `ctrodb` is free on npm for v3 release.

---

## Tooling Summary

| Concern | Tool | Why |
|---|---|---|
| Language | TypeScript 5.7+ | Type safety, DX |
| Build | tsup 8.x | Fast (esbuild), ESM+CJS+IIFE, zero config |
| Test | Vitest 3.x | Fast, native ESM, built-in bench + coverage |
| Lint | Biome 1.9+ | Unified formatter + linter, fast |
| Git hooks | None for v3.0-alpha | Will add husky + lint-staged for v3.0 stable |
| CI | GitHub Actions | Free, integrated |
| Release | semantic-release (v3.0 stable) | Automated versioning + changelog |

## Why These Choices

### tsup over Rollup
- 10x faster builds (esbuild vs Rollup)
- Built-in TypeScript support (no Babel/plugins needed)
- Native ESM + CJS + IIFE output support
- Zero config for most use cases
- Tree-shaking built in

### Vitest over Jest
- Native ESM support (no transform issues)
- Faster (esbuild-based)
- Built-in benchmarking
- Better TypeScript support
- Compatible with Jest expectations/mocks

### Biome over ESLint + Prettier
- Single tool for lint + format (no config duplication)
- 10-100x faster
- Zero configuration to start
- Growing ecosystem, becoming the standard
- No plugins needed

### No husky/lint-staged for alpha
- Simplifies initial setup
- Will add before stable release
- Developers can still run lint/test manually during development
