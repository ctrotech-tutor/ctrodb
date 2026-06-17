# Plan 02 — API Design

## Design Principles

1. **Intuitive** — The API should feel familiar. If you know Prisma or Laravel Eloquent, you know ctrodb.
2. **Chainable** — Every method returns `this` or a new instance for fluent chaining.
3. **Consistent** — Similar operations have similar signatures across the entire API.
4. **Explicit** — No magic. No implicit side effects. Everything is clear from the call.
5. **Framework-agnostic** — The core API doesn't reference React, Vue, or any framework.
6. **Type-safe** — TypeScript generics provide end-to-end type safety without sacrificing the JS experience.

## Complete Public API

### 1. Database Class

```typescript
class Database {
  constructor(config: DatabaseConfig);

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Collections
  collection<T extends Record<string, any> = Record<string, any>>(
    name: string
  ): Collection<T>;

  // Transactions
  transaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>
  ): Promise<T>;

  // Event listeners
  on(event: 'change', callback: ChangeCallback): () => void;
  off(event: 'change', callback: ChangeCallback): void;

  // State
  readonly isConnected: boolean;
  readonly name: string;
  readonly adapter: string;
}

interface DatabaseConfig {
  name?: string;                           // default: 'ctrodb'
  adapter?: 'indexeddb' | 'memory';        // default: 'indexeddb' (browser) / 'memory' (Node)
  schema?: SchemaConfig;                   // optional schema definition
  plugins?: CtroDBPlugin[];                // optional plugins
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';  // default: 'warn'
  migrations?: Migration[];                // optional migration definitions
}
```

### 2. Collection Class

```typescript
class Collection<T extends Record<string, any>> {
  readonly name: string;

  // CRUD
  create(data: Omit<T, 'id'>): Promise<Model<T> & T>;
  get(id: ID): Promise<(Model<T> & T) | undefined>;
  getAll(): Promise<(Model<T> & T)[]>;
  update(id: ID, changes: Partial<T>): Promise<Model<T> & T>;
  delete(id: ID): Promise<void>;
  deleteMany(ids: ID[]): Promise<void>;
  put(data: T): Promise<Model<T> & T>;              // upsert (create or update by id)

  // Count
  count(): Promise<number>;

  // Queries
  query(): QueryBuilder<T>;

  // Internal (used by Model and Query)
  _toModel(data: T): Model<T> & T;
  _toModels(data: T[]): (Model<T> & T)[];
  _getSchema(): CollectionSchema | undefined;
  _executeQuery(plan: QueryPlan): Promise<T[]>;
}
```

### 3. QueryBuilder Class

```typescript
class QueryBuilder<T extends Record<string, any>> {
  // Conditions (AND — added to current group)
  where<K extends keyof T>(
    field: K,
    operator: '==' | '!=' | '>' | '<' | '>=' | '<=',
    value: T[K]
  ): this;
  where<K extends keyof T>(
    field: K,
    value: T[K]
  ): this;  // shorthand for '=='

  // OR conditions (new group)
  orWhere(callback: (q: QueryBuilder<T>) => void): this;

  // Full-text search (requires FTS plugin)
  search(field: string, query: string): this;

  // Ordering
  sort(spec: Partial<Record<keyof T, 'asc' | 'desc'>>): this;

  // Pagination
  limit(n: number): this;
  offset(n: number): this;

  // Terminal methods
  fetch(): Promise<(Model<T> & T)[]>;
  first(): Promise<(Model<T> & T) | undefined>;
  count(): Promise<number>;
  toArray(): Promise<T[]>;  // raw objects, not models

  // Reactivity
  observe(callback: (results: (Model<T> & T)[]) => void): () => void;

  // Eager loading (requires Relations plugin)
  include(...relations: string[]): this;
}
```

### 4. Model Class

```typescript
class Model<T extends Record<string, any>> {
  // Direct property access via Proxy
  // model.name → reads from internal data
  // model.id   → always returns the record ID

  readonly id: ID;

  // Methods
  update(changes: Partial<T>): Promise<Model<T> & T>;
  delete(): Promise<void>;
  toJSON(): T;
  refresh(): Promise<Model<T> & T>;  // re-fetch from database

  // Relations (added by Relations plugin)
  // model.posts      → QueryBuilder (has_many)
  // model.author     → QueryBuilder (belongs_to)

  // Methods are bound to the model instance via Proxy
  // (this always refers to the correct model)
}
```

### 5. TransactionContext

```typescript
class TransactionContext {
  collection<T>(name: string): TransactionCollection<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

class TransactionCollection<T> {
  create(data: T): Promise<T & { id: ID }>;     // returns raw data, not Model
  get(id: ID): Promise<T | undefined>;
  getAll(): Promise<T[]>;
  update(id: ID, changes: Partial<T>): Promise<T>;
  delete(id: ID): Promise<void>;
}
```

### 6. Schema

```typescript
interface SchemaConfig {
  version: number;
  collections: Record<string, CollectionSchema>;
}

interface CollectionSchema {
  fields: Record<string, FieldDefinition>;
  indexes?: IndexDefinition[];
  searchable?: string[];    // fields to enable FTS on
  relations?: Record<string, RelationDefinition>;
}

interface FieldDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: any;
  validate?: 'email' | 'url' | 'regex' | RegExp | ((value: any) => boolean);
  min?: number;              // for number type
  max?: number;              // for number type
  maxLength?: number;        // for string type
  items?: FieldDefinition;   // for array type (items schema)
  unique?: boolean;          // unique constraint via index
}

interface IndexDefinition {
  field: string;
  unique?: boolean;
}

interface RelationDefinition {
  type: 'has_many' | 'belongs_to' | 'has_one';
  collection: string;
  foreignKey: string;
}
```

### 7. Plugins

```typescript
interface CtroDBPlugin {
  name: string;
  version?: string;

  // Hooks
  onDatabaseInit?(db: Database): void;
  onCollectionInit?(collection: Collection): void;
  onQuery?(query: InternalQuery): InternalQuery;
  onBeforeCreate?(collection: string, data: any): any;
  onAfterCreate?(collection: string, record: any): void;
  onBeforeUpdate?(collection: string, id: any, changes: any): any;
  onBeforeDelete?(collection: string, id: any): void;
  onStorageInit?(adapter: StorageAdapter): void;
}
```

### 8. React Bindings

```typescript
// useQuery — reactive query that returns results as state
function useQuery<T>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  deps?: any[]
): (Model<T> & T)[];

// useDoc — reactive single document
function useDoc<T>(
  collectionName: string,
  id: ID | undefined
): (Model<T> & T) | undefined;

// useMutation — create/update/delete with loading state
function useMutation<T>(
  collectionName: string
): {
  create: (data: T) => Promise<Model<T> & T>;
  update: (id: ID, changes: Partial<T>) => Promise<Model<T> & T>;
  delete: (id: ID) => Promise<void>;
  loading: boolean;
  error: Error | undefined;
};
```

## CDN / Script Tag API

```html
<script src="https://unpkg.com/ctrodb"></script>
<script>
  // CtroDB is a global variable
  const { Database, Schema } = CtroDB;

  const db = new Database('myapp', {
    schema: {
      version: 1,
      collections: {
        todos: {
          fields: {
            text: { type: 'string', required: true },
            done: { type: 'boolean' },
          },
        },
      },
    },
  });

  async function main() {
    await db.connect();

    const todos = db.collection('todos');

    // Reactive UI
    todos.query().observe(items => {
      document.getElementById('list').innerHTML =
        items.map(t => `<li>${t.text} ${t.done ? '✓' : ''}</li>`).join('');
    });

    // Add todo
    await todos.create({ text: 'Build ctrodb', done: false });
  }

  main();
</script>
```

## Error Messages (Examples)

All errors are thrown as custom classes with clear, actionable messages:

```
CollectionNotFoundError:
  Collection "dogs" not found. Available collections: users, posts, comments

ValidationError:
  Field "email" in collection "users" must be a valid email address. Got: "not-an-email"

QueryWarning (console.warn, not thrown):
  Query on "users.status" uses a full scan (no matching index).
  Add an index on "status" to optimize performance for large datasets.

SchemaError:
  Schema version must be a positive integer. Got: 0

ConnectionError:
  Database "myapp" is not connected. Call db.connect() before performing operations.

IndexNotFoundError:
  Index "age" not found on collection "users". Available indexes: email, name

TransactionError:
  Transaction failed. All changes have been rolled back.
  Caused by: [original error]
```

## API Usage Examples

### Todo App (CDN)

```html
<script src="https://unpkg.com/ctrodb"></script>
<script>
  const { Database } = CtroDB;

  const db = new Database('todos', {
    schema: {
      version: 1,
      collections: {
        tasks: {
          fields: {
            text: { type: 'string', required: true },
            done: { type: 'boolean' },
          },
        },
      },
    },
  });

  async function init() {
    await db.connect();
    const tasks = db.collection('tasks');

    tasks.query().observe(allTasks => {
      document.getElementById('app').innerHTML = `
        <h1>Tasks (${allTasks.length})</h1>
        <ul>
          ${allTasks.map(t => `
            <li style="${t.done ? 'text-decoration: line-through' : ''}"
                onclick="toggle(${t.id})">
              ${t.text}
              <button onclick="event.stopPropagation(); remove(${t.id})">✕</button>
            </li>
          `).join('')}
        </ul>
        <input id="newTask" placeholder="Add task..." />
        <button onclick="add()">Add</button>
      `;
    });
  }

  window.add = async () => {
    const input = document.getElementById('newTask');
    if (input.value.trim()) {
      await db.collection('tasks').create({ text: input.value.trim(), done: false });
      input.value = '';
    }
  };

  window.toggle = async (id) => {
    const task = await db.collection('tasks').get(id);
    await task.update({ done: !task.done });
  };

  window.remove = async (id) => {
    await db.collection('tasks').delete(id);
  };

  init();
</script>
```

### React Todo (npm)

```tsx
import { Database } from 'ctrodb';
import { useQuery, useMutation } from 'ctrodb/react';
import { useEffect, useState } from 'react';

const db = new Database('todos', { /* schema */ });
db.connect();

function TodoApp() {
  const todos = useQuery('tasks');
  const { create, update, delete: remove } = useMutation('tasks');
  const [text, setText] = useState('');

  return (
    <div>
      <h1>Tasks ({todos.length})</h1>
      <ul>
        {todos.map(t => (
          <li key={t.id} style={{ textDecoration: t.done ? 'line-through' : '' }}>
            <span onClick={() => update(t.id, { done: !t.done })}>{t.text}</span>
            <button onClick={() => remove(t.id)}>✕</button>
          </li>
        ))}
      </ul>
      <input value={text} onChange={e => setText(e.target.value)} />
      <button onClick={() => { create({ text, done: false }); setText(''); }}>Add</button>
    </div>
  );
}
```

### Query Examples

```typescript
// Basic queries
const adults = await users.query().where('age', '>=', 18).fetch();
const byName = await users.query().where('name', 'Alice').first();
const withRange = await products.query().where('price', '>=', 10).where('price', '<=', 100).fetch();

// OR queries
const results = await products.query()
  .where('category', 'electronics')
  .orWhere(q => q.where('featured', true))
  .fetch();

// Sorted and paginated
const recent = await posts.query()
  .where('published', true)
  .sort({ createdAt: 'desc' })
  .limit(10)
  .offset(0)
  .fetch();

// Count
const total = await users.query().where('active', true).count();

// Reactive
const unsub = users.query().where('age', '>=', 18).observe(renderUsers);

// Transactions
await db.transaction(async (ctx) => {
  const users = ctx.collection('users');
  const audit = ctx.collection('audit_log');
  const user = await users.get(1);
  await audit.create({ action: 'login', userId: user.id, timestamp: Date.now() });
});
```
