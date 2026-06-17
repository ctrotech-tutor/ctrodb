# Plan 08 — Framework Bindings

## Design Philosophy

The core of ctrodb must be **framework-agnostic**. It runs anywhere JavaScript runs — browser `<script>` tag, Node.js, Bun, Deno, React Native — without any framework dependency.

Framework bindings are **separate** — they import the core and provide framework-specific APIs. This ensures:

1. **Core stays tiny** — no React/Vue/Svelte dependencies in the main bundle
2. **Tree-shaking works** — framework code is only loaded by those who use it
3. **Framework choice is yours** — we support your framework, we don't force one

## CDN / Script Tag (No Framework)

This is the primary use case for junior devs. The UMD build includes everything and exposes a global `CtroDB` object.

### UMD Build

```javascript
// tsup config generates:
// dist/index.iife.js — includes core + IDB adapter + FTS + Relations + Validation
// Exposes global: window.CtroDB = { Database, Schema, ... }
```

### HTML Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>My First CtroDB App</title>
</head>
<body>
  <h1>My Todo List</h1>
  <ul id="todo-list"></ul>
  <input id="new-todo" placeholder="Add todo..." />
  <button id="add-btn">Add</button>
  <button id="clear-btn">Clear Done</button>

  <!-- One script tag — everything included -->
  <script src="https://unpkg.com/ctrodb@3"></script>
  <script>
    // Global object is available
    const { Database } = CtroDB;

    const db = new Database('my-first-app', {
      schema: {
        version: 1,
        collections: {
          todos: {
            fields: {
              text: { type: 'string', required: true },
              done: { type: 'boolean' },
              createdAt: { type: 'number' },
            },
          },
        },
      },
      plugins: [CtroDB.relations(), CtroDB.fts()],
    });

    async function start() {
      await db.connect();
      const todos = db.collection('todos');

      // Reactive UI — observe auto-updates
      todos.query().observe(allTodos => {
        const list = document.getElementById('todo-list');
        list.innerHTML = '';
        allTodos
          .sort((a, b) => a.createdAt - b.createdAt)
          .forEach(todo => {
            const li = document.createElement('li');
            li.style.textDecoration = todo.done ? 'line-through' : '';
            li.textContent = todo.text;
            li.onclick = async () => {
              await todo.update({ done: !todo.done });
            };
            list.appendChild(li);
          });
      });

      // Add todo
      document.getElementById('add-btn').onclick = async () => {
        const input = document.getElementById('new-todo');
        const text = input.value.trim();
        if (text) {
          await todos.create({ text, done: false, createdAt: Date.now() });
          input.value = '';
        }
      };
    }

    start();
  </script>
</body>
</html>
```

### Global API Surface

```javascript
window.CtroDB = {
  // Core
  Database,
  Schema,        // optional helper for schema definition
  LogLevel,

  // Plugins (factory functions)
  fts,
  relations,
  validation,

  // Version
  VERSION: '3.0.0',
};
```

---

## React Bindings

### Package

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./react": {
      "import": "./dist/react.mjs",
      "require": "./dist/react.cjs",
      "types": "./dist/react.d.ts"
    }
  }
}
```

```tsx
import { useQuery, useDoc, useMutation } from 'ctrodb/react';
```

### Hooks API

```typescript
// useQuery — reactive query that re-renders on data changes
function useQuery<T extends Record<string, any>>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  options?: { deps?: any[] }
): (Model<T> & T)[];

// useDoc — reactive single document by ID
function useDoc<T extends Record<string, any>>(
  collectionName: string,
  id: ID | undefined
): (Model<T> & T) | undefined;

// useMutation — create/update/delete with loading/error state
function useMutation<T extends Record<string, any>>(
  collectionName: string
): {
  create: (data: Omit<T, 'id'>) => Promise<Model<T> & T>;
  update: (id: ID, changes: Partial<T>) => Promise<Model<T> & T>;
  delete: (id: ID) => Promise<void>;
  loading: boolean;
  error: Error | undefined;
  reset: () => void;
};
```

### Usage Example

```tsx
import { Database } from 'ctrodb';
import { useQuery, useMutation } from 'ctrodb/react';

// Initialize database once (outside component or via context)
const db = new Database('myapp', { /* config */ });
db.connect();

// Database provider (optional, for testing/SSR)
// <DatabaseProvider db={db}>...</DatabaseProvider>

interface User {
  name: string;
  email: string;
  age: number;
}

function UserList() {
  const users = useQuery<User>('users', q => q.where('age', '>=', 18).sort({ name: 'asc' }));
  const { create, delete: remove } = useMutation<User>('users');

  return (
    <div>
      <h2>Users ({users.length})</h2>
      <ul>
        {users.map(user => (
          <li key={user.id}>
            {user.name} ({user.age}) — {user.email}
            <button onClick={() => remove(user.id)}>Delete</button>
          </li>
        ))}
      </ul>
      <button onClick={() => create({ name: 'New User', email: 'new@user.com', age: 25 })}>
        Add User
      </button>
    </div>
  );
}
```

### Implementation

```typescript
// src/bindings/react.ts
import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import { Database, getDefaultDatabase } from '../database';
import { QueryBuilder } from '../query/builder';
import type { Model } from '../model';

// Internal: cache database instances
let defaultDb: Database | null = null;

export function setDefaultDatabase(db: Database): void {
  defaultDb = db;
}

export function getDb(): Database {
  if (!defaultDb) {
    throw new Error(
      'No database instance found. Call setDefaultDatabase(db) or provide a DatabaseProvider.'
    );
  }
  return defaultDb;
}

export function useQuery<T extends Record<string, any>>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  options?: { deps?: any[] }
): (Model<T> & T)[] {
  const db = getDb();
  const [results, setResults] = useState<(Model<T> & T)[]>([]);
  const deps = options?.deps || [];

  useEffect(() => {
    const collection = db.collection<T>(collectionName);
    let query = collection.query();
    if (queryFn) query = queryFn(query);

    const unsub = query.observe(newResults => {
      setResults(newResults);
    });

    return unsub;
  }, [collectionName, ...deps]);

  return results;
}

export function useDoc<T extends Record<string, any>>(
  collectionName: string,
  id: ID | undefined
): (Model<T> & T) | undefined {
  const results = useQuery<T>(
    collectionName,
    id ? (q) => q.where('id' as any, id as any) : undefined,
    { deps: [id] }
  );
  return results?.[0];
}

export function useMutation<T extends Record<string, any>>(
  collectionName: string
) {
  const db = getDb();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>();

  const create = useCallback(async (data: Omit<T, 'id'>): Promise<Model<T> & T> => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await db.collection<T>(collectionName).create(data as any);
      return result;
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [collectionName]);

  const update = useCallback(async (id: ID, changes: Partial<T>): Promise<Model<T> & T> => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await db.collection<T>(collectionName).update(id, changes);
      return result;
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [collectionName]);

  const del = useCallback(async (id: ID): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      await db.collection<T>(collectionName).delete(id);
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [collectionName]);

  const reset = useCallback(() => {
    setError(undefined);
    setLoading(false);
  }, []);

  return { create, update, delete: del, loading, error, reset };
}
```

### Database Provider (Optional)

```tsx
import React, { createContext, useContext } from 'react';
import { Database } from 'ctrodb';
import { setDefaultDatabase } from 'ctrodb/react';

const DbContext = createContext<Database | null>(null);

export function DatabaseProvider({ db, children }: { db: Database; children: React.ReactNode }) {
  setDefaultDatabase(db);
  return <DbContext.Provider value={db}>{children}</DbContext.Provider>;
}

export function useDatabase(): Database {
  const db = useContext(DbContext);
  if (!db) throw new Error('useDatabase must be used within a DatabaseProvider');
  return db;
}
```

---

## Other Framework Bindings (Future)

### Vue 3

```typescript
// src/bindings/vue.ts
import { ref, onMounted, onUnmounted } from 'vue';

export function useQuery<T>(collectionName: string, queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>) {
  const items = ref<(Model<T> & T)[]>([]);
  const loading = ref(true);
  const error = ref<Error | undefined>();

  let unsub: (() => void) | undefined;

  onMounted(async () => {
    const db = getDb();
    const collection = db.collection<T>(collectionName);
    let query = collection.query();
    if (queryFn) query = queryFn(query);

    unsub = query.observe(results => {
      items.value = results;
      loading.value = false;
    });
  });

  onUnmounted(() => unsub?.());

  return { items, loading, error };
}
```

### Svelte 5

```typescript
// src/bindings/svelte.ts
import { writable } from 'svelte/store';

export function createQuery<T>(collectionName: string, queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>) {
  const store = writable<(Model<T> & T)[]>([]);
  const db = getDb();
  const collection = db.collection<T>(collectionName);
  let query = collection.query();
  if (queryFn) query = queryFn(query);

  const unsub = query.observe(results => store.set(results));

  return {
    subscribe: store.subscribe,
    destroy: unsub,
  };
}
```

### SolidJS

```typescript
// src/bindings/solid.ts
import { createSignal, onCleanup } from 'solid-js';

export function createQuery<T>(collectionName: string, queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>) {
  const db = getDb();
  const collection = db.collection<T>(collectionName);
  let query = collection.query();
  if (queryFn) query = queryFn(query);

  const observer = new QueryObserver(query, collection);

  onCleanup(() => observer.destroy());

  return observer.signal; // Returns a Signal<T[]> directly — Solid subscribes natively
}
```

---

## Framework Binding Distribution

| Framework | Package | Status |
|---|---|---|
| Vanilla JS (CDN) | `ctrodb` (UMD build) | ✅ v3.0 |
| React | `ctrodb/react` (subpath export) | ✅ v3.0 |
| Vue 3 | `@ctrodb/vue` (separate package) | ⏳ v3.1 |
| Svelte 5 | `@ctrodb/svelte` (separate package) | ⏳ v3.1 |
| SolidJS | `@ctrodb/solid` (separate package) | ⏳ v3.2 |

Only Vanilla JS (CDN) and React ship with v3.0. Other frameworks get separate packages post-release based on community demand.
