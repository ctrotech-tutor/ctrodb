# Plan 06 — Storage Adapters

## Adapter Interface

All storage backends implement a common interface:

```typescript
interface StorageAdapter {
  readonly name: string;

  // Lifecycle
  connect(name: string, schema: SchemaConfig | null): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Schema & Migration
  getSchemaVersion(): Promise<number>;
  setSchemaVersion(version: number): Promise<void>;
  runMigration(version: number, fn: (ctx: MigrationContext) => Promise<void>): Promise<void>;

  // CRUD
  create(collection: string, data: any): Promise<any>;
  findById(collection: string, id: ID): Promise<any | undefined>;
  findAll(collection: string): Promise<any[]>;
  update(collection: string, id: ID, changes: any): Promise<any>;
  delete(collection: string, id: ID): Promise<void>;
  deleteMany(collection: string, ids: ID[]): Promise<void>;

  // Query
  scanIndex(
    collection: string,
    indexName: string,
    range: IDBKeyRange | undefined,
    postFilters: QueryCondition[]
  ): Promise<any[]>;

  // Transactions
  transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T>;

  // Metadata
  getMetadata(key: string): Promise<any>;
  setMetadata(key: string, value: any): Promise<void>;
}
```

---

## Adapter 1: MemoryAdapter

For testing, Node.js, and development environments. Stores everything in a JavaScript Map.

### Implementation

```typescript
class MemoryAdapter implements StorageAdapter {
  readonly name = 'memory';

  #data: Map<string, Map<ID, any>> = new Map();
  #counters: Map<string, number> = new Map();
  #meta: Map<string, any> = new Map();
  #connected = false;

  async connect(name: string, schema: SchemaConfig | null): Promise<void> {
    this.#connected = true;
    // Initialize collections from schema
    if (schema?.collections) {
      for (const [name] of Object.entries(schema.collections)) {
        this.#data.set(name, new Map());
        this.#counters.set(name, 1);
      }
    }
    this.#data.set('_ctrodb_meta', new Map());
  }

  async disconnect(): Promise<void> {
    this.#data.clear();
    this.#counters.clear();
    this.#meta.clear();
    this.#connected = false;
  }

  isConnected(): boolean { return this.#connected; }

  async create(collection: string, data: any): Promise<any> {
    this.#ensureCollection(collection);
    const store = this.#data.get(collection)!;
    const id = this.#counters.get(collection)!;
    this.#counters.set(collection, id + 1);
    const record = { id, ...data };
    store.set(id, record);
    return { ...record };
  }

  async findById(collection: string, id: ID): Promise<any | undefined> {
    const store = this.#data.get(collection);
    if (!store) return undefined;
    const record = store.get(id);
    return record ? { ...record } : undefined;
  }

  async findAll(collection: string): Promise<any[]> {
    const store = this.#data.get(collection);
    if (!store) return [];
    return [...store.values()].map(r => ({ ...r }));
  }

  async update(collection: string, id: ID, changes: any): Promise<any> {
    const store = this.#data.get(collection);
    if (!store) throw new Error(`Collection "${collection}" not found`);
    const record = store.get(id);
    if (!record) throw new Error(`Record "${id}" not found in "${collection}"`);
    const updated = { ...record, ...changes };
    store.set(id, updated);
    return { ...updated };
  }

  async delete(collection: string, id: ID): Promise<void> {
    this.#data.get(collection)?.delete(id);
  }

  async deleteMany(collection: string, ids: ID[]): Promise<void> {
    const store = this.#data.get(collection);
    if (!store) return;
    for (const id of ids) store.delete(id);
  }

  async scanIndex(
    collection: string,
    indexName: string,
    range: IDBKeyRange | undefined,
    postFilters: QueryCondition[]
  ): Promise<any[]> {
    // Memory adapter — filter in-memory (no real index)
    // For optimization, we could maintain index maps, but unnecessary for most use cases
    const all = await this.findAll(collection);
    let results = all;

    // Apply index filter
    if (range) {
      results = results.filter(r => {
        const val = r[indexName];
        if (range.lower !== undefined) {
          const lowerOk = range.lowerOpen ? val > range.lower : val >= range.lower;
          if (!lowerOk) return false;
        }
        if (range.upper !== undefined) {
          const upperOk = range.upperOpen ? val < range.upper : val <= range.upper;
          if (!upperOk) return false;
        }
        return true;
      });
    }

    // Apply post-filters
    for (const cond of postFilters) {
      results = results.filter(r => {
        const val = r[cond.field];
        switch (cond.op) {
          case '==': return val === cond.value;
          case '!=': return val !== cond.value;
          case '>':  return val > cond.value;
          case '>=': return val >= cond.value;
          case '<':  return val < cond.value;
          case '<=': return val <= cond.value;
          default: return true;
        }
      });
    }

    return results;
  }

  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    // Memory adapter transactions — simple wrapper with rollback on error
    const snapshot = this.#snapshot();
    try {
      const ctx = new MemoryTransactionContext(this);
      const result = await fn(ctx);
      return result;
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  async getMetadata(key: string): Promise<any> {
    return this.#meta.get(key);
  }

  async setMetadata(key: string, value: any): Promise<void> {
    this.#meta.set(key, value);
  }

  // Private helpers
  #ensureCollection(name: string): void {
    if (!this.#data.has(name)) {
      this.#data.set(name, new Map());
      this.#counters.set(name, 1);
    }
  }

  #snapshot(): any {
    return {
      data: new Map([...this.#data].map(([k, v]) => [k, new Map(v)])),
      counters: new Map(this.#counters),
    };
  }

  #restore(snapshot: any): void {
    this.#data = snapshot.data;
    this.#counters = snapshot.counters;
  }

  async getSchemaVersion(): Promise<number> {
    return this.#meta.get('schemaVersion') || 0;
  }

  async setSchemaVersion(version: number): Promise<void> {
    this.#meta.set('schemaVersion', version);
  }

  async runMigration(version: number, fn: (ctx: MigrationContext) => Promise<void>): Promise<void> {
    await this.transaction(async (ctx) => {
      const migrationCtx = new MemoryMigrationContext(ctx, this);
      await fn(migrationCtx);
      await this.setSchemaVersion(version);
    });
  }
}
```

---

## Adapter 2: IndexedDBAdapter

For production browser usage. Wraps the native IndexedDB API.

### Connection Management

```typescript
// src/adapter/idb/connection.ts
function openDB(dbName: string, version: number, onUpgrade: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, version);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      onUpgrade(db, event.oldVersion);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      console.warn(`[ctrodb] Database "${dbName}" blocked. Close other tabs using this database.`);
    };
  });
}
```

### CRUD Operations

```typescript
// src/adapter/idb/crud.ts
function idbCreate(db: IDBDatabase, collection: string, data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, 'readwrite');
    const store = tx.objectStore(collection);
    const request = store.add(data);

    request.onsuccess = () => resolve({ id: request.result, ...data });
    request.onerror = () => reject(request.error);
  });
}

function idbFindById(db: IDBDatabase, collection: string, id: ID): Promise<any | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, 'readonly');
    const store = tx.objectStore(collection);
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbFindAll(db: IDBDatabase, collection: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, 'readonly');
    const store = tx.objectStore(collection);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function idbUpdate(db: IDBDatabase, collection: string, id: ID, changes: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, 'readwrite');
    const store = tx.objectStore(collection);

    const getRequest = store.get(id);
    getRequest.onsuccess = () => {
      const existing = getRequest.result;
      if (!existing) {
        reject(new Error(`Record "${id}" not found in "${collection}"`));
        return;
      }
      const updated = { ...existing, ...changes };
      const putRequest = store.put(updated);
      putRequest.onsuccess = () => resolve(updated);
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

function idbDelete(db: IDBDatabase, collection: string, id: ID): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, 'readwrite');
    const store = tx.objectStore(collection);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
```

### Index Scan

```typescript
function idbScanIndex(
  db: IDBDatabase,
  collection: string,
  indexName: string,
  range: IDBKeyRange | undefined,
  postFilters: QueryCondition[]
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(collection, 'readonly');
    const store = tx.objectStore(collection);
    const index = store.index(indexName);
    const request = range ? index.getAll(range) : index.getAll();

    request.onsuccess = () => {
      let results = request.result || [];

      // Apply post-filter conditions
      for (const cond of postFilters) {
        results = results.filter(r => {
          const val = r[cond.field];
          switch (cond.op) {
            case '==': return val === cond.value;
            case '!=': return val !== cond.value;
            case '>':  return val > cond.value;
            case '>=': return val >= cond.value;
            case '<':  return val < cond.value;
            case '<=': return val <= cond.value;
            default: return true;
          }
        });
      }

      resolve(results);
    };

    request.onerror = () => reject(request.error);
  });
}
```

### Migration Handler

```typescript
// src/adapter/idb/migration.ts
function createMigrationHandler(schema: SchemaConfig | null) {
  return function onUpgrade(db: IDBDatabase, oldVersion: number): void {
    if (!schema) return;

    const newVersion = db.version;

    for (const [collectionName, collectionSchema] of Object.entries(schema.collections)) {
      // Create object store if it doesn't exist
      if (!db.objectStoreNames.contains(collectionName)) {
        const store = db.createObjectStore(collectionName, {
          keyPath: 'id',
          autoIncrement: true,
        });

        // Create indexes
        if (collectionSchema.indexes) {
          for (const indexDef of collectionSchema.indexes) {
            store.createIndex(indexDef.field, indexDef.field, {
              unique: indexDef.unique || false,
            });
          }
        }
      }
    }
  };
}
```

### Full IndexedDBAdapter Implementation

```typescript
class IndexedDBAdapter implements StorageAdapter {
  readonly name = 'indexeddb';

  #db: IDBDatabase | null = null;
  #dbName: string = '';
  #connected = false;

  async connect(name: string, schema: SchemaConfig | null): Promise<void> {
    this.#dbName = name;
    const version = schema?.version || 1;
    const migrationHandler = createMigrationHandler(schema);
    this.#db = await openDB(name, version, migrationHandler);
    this.#connected = true;
  }

  disconnect(): void {
    this.#db?.close();
    this.#db = null;
    this.#connected = false;
  }

  isConnected(): boolean { return this.#connected; }

  // Delegate to CRUD functions
  async create(collection: string, data: any): Promise<any> {
    this.#ensureConnected();
    return idbCreate(this.#db!, collection, data);
  }

  async findById(collection: string, id: ID): Promise<any | undefined> {
    this.#ensureConnected();
    return idbFindById(this.#db!, collection, id);
  }

  async findAll(collection: string): Promise<any[]> {
    this.#ensureConnected();
    return idbFindAll(this.#db!, collection);
  }

  async update(collection: string, id: ID, changes: any): Promise<any> {
    this.#ensureConnected();
    return idbUpdate(this.#db!, collection, id, changes);
  }

  async delete(collection: string, id: ID): Promise<void> {
    this.#ensureConnected();
    return idbDelete(this.#db!, collection, id);
  }

  async deleteMany(collection: string, ids: ID[]): Promise<void> {
    this.#ensureConnected();
    const tx = this.#db!.transaction(collection, 'readwrite');
    const store = tx.objectStore(collection);
    for (const id of ids) {
      store.delete(id);
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async scanIndex(
    collection: string,
    indexName: string,
    range: IDBKeyRange | undefined,
    postFilters: QueryCondition[]
  ): Promise<any[]> {
    this.#ensureConnected();
    return idbScanIndex(this.#db!, collection, indexName, range, postFilters);
  }

  async transaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    this.#ensureConnected();
    // For IndexedDB, we create a readwrite transaction on all involved collections
    // and pass a scoped context
    return fn(new IDBTransactionContext(this.#db!));
  }

  async getMetadata(key: string): Promise<any> {
    const meta = await idbFindById(this.#db!, '_ctrodb_meta', key);
    return meta?.value;
  }

  async setMetadata(key: string, value: any): Promise<void> {
    const store = '_ctrodb_meta';
    if (!this.#db!.objectStoreNames.contains(store)) {
      // Metadata store might not exist on first run before migration
      return;
    }
    const existing = await idbFindById(this.#db!, store, key);
    if (existing) {
      await idbUpdate(this.#db!, store, key, { value });
    } else {
      await idbCreate(this.#db!, store, { id: key, key, value });
    }
  }

  async getSchemaVersion(): Promise<number> {
    return (await this.getMetadata('schemaVersion')) || 0;
  }

  async setSchemaVersion(version: number): Promise<void> {
    await this.setMetadata('schemaVersion', version);
  }

  async runMigration(version: number, fn: (ctx: MigrationContext) => Promise<void>): Promise<void> {
    // IDB migration is handled by onupgradeneeded — custom migrations run outside that
    await fn(new IDBMigrationContext(this.#db!));
    await this.setSchemaVersion(version);
  }

  #ensureConnected(): void {
    if (!this.#connected || !this.#db) {
      throw new Error('Database is not connected. Call db.connect() first.');
    }
  }
}
```

## Transaction Context Implementations

```typescript
class MemoryTransactionContext implements TransactionContext {
  constructor(private adapter: MemoryAdapter) {}

  collection(name: string): TransactionCollection {
    return new MemoryTransactionCollection(name, this.adapter);
  }
}

class IDBTransactionContext implements TransactionContext {
  constructor(private db: IDBDatabase) {}

  collection(name: string): TransactionCollection {
    return new IDBTransactionCollection(name, this.db);
  }
}
```

## Adapter Selection Logic

```typescript
function createAdapter(type?: 'indexeddb' | 'memory'): StorageAdapter {
  if (type === 'memory') return new MemoryAdapter();

  if (type === 'indexeddb') return new IndexedDBAdapter();

  // Auto-detect
  if (typeof window !== 'undefined' && window.indexedDB) {
    return new IndexedDBAdapter();
  }

  // Fall back to memory (Node.js, Bun, Deno)
  return new MemoryAdapter();
}
```

## Future Adapters

| Adapter | Priority | Use Case |
|---|---|---|
| Memory | ✅ v3.0 | Testing, Node.js |
| IndexedDB | ✅ v3.0 | Production browser |
| OPFS SQLite (via @sqlite.org) | ⏳ v3.1 | High-performance browser storage |
| Node fs (JSON) | ⏳ v3.1 | Simple Node.js persistence |
| React Native AsyncStorage | ⏳ v3.2 | React Native apps |
