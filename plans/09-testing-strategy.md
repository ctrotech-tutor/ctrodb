# Plan 09 — Testing Strategy

## Testing Philosophy

1. **Test behavior, not implementation** — Tests should verify what the code does, not how it does it
2. **Every public API method must have tests** — Positive cases, negative cases, edge cases
3. **Integration tests > unit tests** — The value is in how components work together
4. **Benchmarks for performance-critical paths** — Know when you regress
5. **Both adapters must be tested** — Memory adapter (fast) and IndexedDB adapter (production)

## Test Stack

| Tool | Purpose |
|---|---|
| **Vitest** | Test runner (fast, native ESM, TypeScript) |
| **fake-indexeddb** | IndexedDB mock for CI/Node.js environments |
| **vitest bench** | Benchmarking |
| **c8** (via vitest) | Code coverage |

## Test Structure

```
tests/
├── unit/
│   ├── schema.test.ts           # Schema validation, defaults
│   ├── signal.test.ts           # Signal, Effect, computed
│   ├── model.test.ts            # Model proxy, methods
│   ├── query-builder.test.ts    # Condition building, chaining
│   ├── query-planner.test.ts    # Plan generation, index selection
│   ├── query-executor.test.ts   # Plan execution, filtering, sorting
│   ├── emitter.test.ts          # Event system
│   ├── errors.test.ts           # Error classes
│   └── plugins/
│       ├── fts.test.ts          # Tokenizer, indexer, search
│       ├── relations.test.ts    # hasMany, belongsTo
│       └── validation.test.ts   # Validation rules
│
├── integration/
│   ├── memory-adapter.test.ts   # Full CRUD + query via MemoryAdapter
│   ├── idb-adapter.test.ts      # Full CRUD + query via IndexedDBAdapter
│   ├── database.test.ts         # Database lifecycle, collection management
│   ├── crud.test.ts             # End-to-end create/read/update/delete
│   ├── queries.test.ts          # Complex queries, OR, sort, pagination
│   ├── reactivity.test.ts       # observe, change tracking
│   ├── transactions.test.ts     # Transaction commit/rollback
│   ├── migrations.test.ts       # Version upgrades
│   ├── fts-integration.test.ts  # FTS with real adapter
│   └── relations-integration.test.ts  # Relations with real adapter
│
├── benchmarks/
│   ├── crud.bench.ts            # Create/find/update/delete throughput
│   ├── query.bench.ts           # Query performance (indexed vs non-indexed)
│   ├── fts.bench.ts             # Search performance
│   └── reactivity.bench.ts      # Observer notification latency
│
└── setup.ts                     # Global test setup
```

## Unit Test Examples

### Schema Tests

```typescript
// tests/unit/schema.test.ts
import { describe, it, expect } from 'vitest';
import { Schema } from '../../src/schema';

describe('Schema', () => {
  it('should accept a valid schema configuration', () => {
    const schema = new Schema({
      version: 1,
      collections: {
        users: {
          fields: {
            name: { type: 'string', required: true },
            age: { type: 'number', min: 0 },
          },
          indexes: [{ field: 'age' }],
        },
      },
    });
    expect(schema.version).toBe(1);
    expect(schema.collections.users.fields.name.type).toBe('string');
  });

  it('should throw for version < 1', () => {
    expect(() => new Schema({ version: 0, collections: { x: { fields: {} } } }))
      .toThrow('Schema version must be a positive integer');
  });

  it('should throw for missing fields definition', () => {
    expect(() => new Schema({ version: 1, collections: { users: {} } }))
      .toThrow('Collection "users" must define fields');
  });

  it('should throw for index referencing non-existent field', () => {
    expect(() => new Schema({
      version: 1,
      collections: {
        users: {
          fields: { name: { type: 'string' } },
          indexes: [{ field: 'nonexistent' }],
        },
      },
    })).toThrow('Index "nonexistent" references non-existent field in collection "users"');
  });
});
```

### Signal Tests

```typescript
// tests/unit/signal.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Signal, Effect } from '../../src/reactive/signal';

describe('Signal', () => {
  it('should store and retrieve the initial value', () => {
    const signal = new Signal(42);
    expect(signal.value).toBe(42);
  });

  it('should update value and notify subscribers', () => {
    const signal = new Signal(0);
    const fn = vi.fn();
    signal.subscribe(fn);
    signal.value = 42;
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('should not notify if value is unchanged (same reference)', () => {
    const signal = new Signal(42);
    const fn = vi.fn();
    signal.subscribe(fn);
    signal.value = 42; // Same value
    expect(fn).not.toHaveBeenCalled();
  });

  it('should return an unsubscribe function', () => {
    const signal = new Signal(0);
    const fn = vi.fn();
    const unsub = signal.subscribe(fn);
    unsub();
    signal.value = 42;
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('Effect', () => {
  it('should run the effect function immediately', () => {
    const fn = vi.fn();
    new Effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should re-run when a dependency changes', () => {
    const signal = new Signal(1);
    const fn = vi.fn(() => { signal.value; }); // access signal to track dependency
    new Effect(fn);
    fn.mockClear();
    signal.value = 2;
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

### Query Planner Tests

```typescript
// tests/unit/query-planner.test.ts
import { describe, it, expect } from 'vitest';
import { QueryPlanner } from '../../src/query/planner';

describe('QueryPlanner', () => {
  const planner = new QueryPlanner();
  const indexes = [{ field: 'age' }, { field: 'email', unique: true }];

  it('should plan index scan for equality on indexed field', () => {
    const plan = planner.plan(
      [[{ type: 'where', field: 'email', op: '==', value: 'a@b.com' }]],
      null,
      indexes
    );
    expect(plan.strategy).toBe('index_scan');
    expect(plan.indexName).toBe('email');
    expect(plan.postFilterConditions).toEqual([]);
  });

  it('should plan index scan with key range for range operator', () => {
    const plan = planner.plan(
      [[{ type: 'where', field: 'age', op: '>=', value: 18 }]],
      null,
      indexes
    );
    expect(plan.strategy).toBe('index_scan');
    expect(plan.indexName).toBe('age');
    expect(plan.range).toBeDefined();
  });

  it('should plan full scan if no index matches', () => {
    const plan = planner.plan(
      [[{ type: 'where', field: 'name', op: '==', value: 'Alice' }]],
      null,
      indexes
    );
    expect(plan.strategy).toBe('full_scan');
  });

  it('should combine index scan with post-filter for mixed conditions', () => {
    const plan = planner.plan(
      [[
        { type: 'where', field: 'age', op: '>=', value: 18 },
        { type: 'where', field: 'name', op: '==', value: 'Alice' },
      ]],
      null,
      indexes
    );
    expect(plan.strategy).toBe('index_scan');
    expect(plan.indexName).toBe('age');
    expect(plan.postFilterConditions.length).toBe(1);
    expect(plan.postFilterConditions[0].field).toBe('name');
  });

  it('should prefer unique equality over non-unique range', () => {
    const plan = planner.plan(
      [[
        { type: 'where', field: 'age', op: '>=', value: 18 },
        { type: 'where', field: 'email', op: '==', value: 'a@b.com' },
      ]],
      null,
      indexes
    );
    // Should pick email (unique, equality) over age (non-unique, range)
    expect(plan.indexName).toBe('email');
  });

  it('should create OR plan with sub-groups', () => {
    const plan = planner.plan(
      [
        [{ type: 'where', field: 'age', op: '>=', value: 18 }],
        [{ type: 'where', field: 'role', op: '==', value: 'admin' }],
      ],
      null,
      indexes
    );
    expect(plan.groupType).toBe('or');
    expect(plan.groups).toHaveLength(2);
  });

  it('should return full scan for empty conditions', () => {
    const plan = planner.plan([], null, indexes);
    expect(plan.strategy).toBe('full_scan');
  });
});
```

## Integration Test Examples

### CRUD via Memory Adapter

```typescript
// tests/integration/memory-adapter.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/database';

describe('MemoryAdapter CRUD', () => {
  let db: Database;

  beforeEach(async () => {
    db = new Database({
      name: 'test',
      adapter: 'memory',
      schema: {
        version: 1,
        collections: {
          users: {
            fields: {
              name: { type: 'string', required: true },
              age: { type: 'number' },
            },
          },
        },
      },
    });
    await db.connect();
  });

  afterEach(() => {
    db.disconnect();
  });

  it('should create and read a record', async () => {
    const users = db.collection('users');
    const user = await users.create({ name: 'Alice', age: 30 });
    expect(user.id).toBeDefined();
    expect(user.name).toBe('Alice');

    const found = await users.get(user.id);
    expect(found?.name).toBe('Alice');
  });

  it('should update a record', async () => {
    const users = db.collection('users');
    const user = await users.create({ name: 'Bob', age: 25 });
    const updated = await users.update(user.id, { age: 26 });
    expect(updated.age).toBe(26);
    expect(updated.name).toBe('Bob'); // Other fields preserved
  });

  it('should delete a record', async () => {
    const users = db.collection('users');
    const user = await users.create({ name: 'Charlie', age: 35 });
    await users.delete(user.id);
    const found = await users.get(user.id);
    expect(found).toBeUndefined();
  });

  it('should find all records', async () => {
    const users = db.collection('users');
    await users.create({ name: 'A', age: 20 });
    await users.create({ name: 'B', age: 30 });
    const all = await users.getAll();
    expect(all.length).toBe(2);
  });
});
```

### Reactive Queries

```typescript
// tests/integration/reactivity.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Database } from '../../src/database';

describe('Reactivity', () => {
  it('observe should call callback immediately with initial results', async () => {
    const db = new Database({ name: 'test', adapter: 'memory' });
    await db.connect();
    const todos = db.collection('todos');

    const fn = vi.fn();
    todos.query().observe(fn);

    // Wait for microtask
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith([]);

    db.disconnect();
  });

  it('observe should trigger after create', async () => {
    const db = new Database({ name: 'test', adapter: 'memory' });
    await db.connect();
    const todos = db.collection('todos');

    const fn = vi.fn();
    todos.query().observe(fn);

    await todos.create({ text: 'Test', done: false });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1][0].length).toBe(1);
    expect(fn.mock.calls[1][0][0].text).toBe('Test');

    db.disconnect();
  });

  it('unsubscribe should stop notifications', async () => {
    const db = new Database({ name: 'test', adapter: 'memory' });
    await db.connect();
    const todos = db.collection('todos');

    const fn = vi.fn();
    const unsub = todos.query().observe(fn);
    unsub();

    await todos.create({ text: 'Should not trigger', done: false });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fn).toHaveBeenCalledTimes(1); // Only initial call

    db.disconnect();
  });
});
```

## Benchmark Examples

```typescript
// tests/benchmarks/query.bench.ts
import { bench, describe } from 'vitest';
import { Database } from '../../src/database';

describe('Query Performance', () => {
  bench('find all — 1000 records', async () => {
    const db = new Database({ name: 'bench', adapter: 'memory' });
    await db.connect();
    const items = db.collection('items');
    for (let i = 0; i < 1000; i++) {
      await items.create({ name: `Item ${i}`, value: i });
    }

    const results = await items.query().fetch();
    db.disconnect();
  });

  bench('query with index — 1000 records', async () => {
    const db = new Database({ name: 'bench', adapter: 'memory' });
    await db.connect();
    const items = db.collection('items');
    for (let i = 0; i < 1000; i++) {
      await items.create({ name: `Item ${i}`, value: i });
    }

    const results = await items.query().where('value', '>=', 500).fetch();
    db.disconnect();
  });

  bench('FTS search — 100 records', async () => {
    const db = new Database({
      name: 'bench',
      adapter: 'memory',
      plugins: [fts()],
    });
    await db.connect();
    const items = db.collection('items');
    for (let i = 0; i < 100; i++) {
      await items.create({ content: `The quick brown fox jumps over the lazy dog ${i}` });
    }

    const results = await items.query().search('content', 'fox').fetch();
    db.disconnect();
  });
});
```

## Test Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',  // For fake-indexeddb compatibility
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/bindings/**'],
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

## CI Test Execution

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'
      - run: npm ci
      - run: npx vitest run          # Unit + integration tests
      - run: npx vitest bench        # Benchmarks (no thresholds, informational)
      - run: npx tsc --noEmit        # Type checking
      - run: npx biome ci src/       # Linting
      - run: npx tsup                # Build verification
```

## Coverage Targets

| Area | Target |
|---|---|
| Core (Database, Collection, Schema, Model) | 95%+ |
| Query engine (Builder, Planner, Executor) | 95%+ |
| Reactivity (Signal, Effect, Observer) | 95%+ |
| Storage adapters (Memory, IndexedDB) | 90%+ |
| Plugins (FTS, Relations, Validation) | 90%+ |
| Errors and edge cases | 85%+ |
| **Overall** | **90%+** |
