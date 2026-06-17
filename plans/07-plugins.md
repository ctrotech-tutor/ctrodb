# Plan 07 — Plugins

## Plugin System Architecture

Plugins extend ctrodb's functionality through lifecycle hooks. They are loaded at database initialization:

```typescript
interface CtroDBPlugin {
  name: string;
  version?: string;

  // Hooks into the database lifecycle
  onDatabaseInit?(db: Database): void;
  onCollectionInit?(collection: Collection): void;
  onQuery?(query: InternalQuery): InternalQuery;
  onBeforeCreate?(collection: string, data: any): any;
  onAfterCreate?(collection: string, record: any): void;
  onBeforeUpdate?(collection: string, id: any, changes: any): any;
  onBeforeDelete?(collection: string, id: any): void;
  onStorageInit?(adapter: StorageAdapter): void;
  onAdapterMethod?(method: string, args: any[]): any;
}

function applyPlugins<T>(hooks: PluginHook[], plugin: CtroDBPlugin, ...args: any[]): T {
  for (const hook of hooks) {
    if (hook) {
      const result = hook(...args);
      if (result !== undefined) args[0] = result; // Allow mutation
    }
  }
  return args[0];
}
```

---

## Plugin 1: Full-Text Search (FTS)

### Overview

Provides `search()` on queries, enabling word-based full-text search on specified fields using an inverted index stored in a separate IndexedDB object store.

### Tokenizer

```typescript
// src/plugins/fts/tokenizer.ts

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or',
  'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'will', 'with',
]);

function tokenize(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  // Lowercase, split on non-alphanumeric
  const words = text.toLowerCase().split(/[^a-z0-9]+/);

  // Filter stop words and empty strings, deduplicate
  return [...new Set(words.filter(w => w.length > 0 && !STOP_WORDS.has(w)))];
}
```

### Inverted Index

```typescript
// The inverted index is stored in a special collection: '_ctrodb_fts'
// Each record:
// {
//   id: string,          // "{collection}:{token}"
//   token: string,
//   collection: string,
//   docIds: ID[]         // Array of document IDs containing this token
// }

class FTSIndexer {
  private adapter: StorageAdapter;

  constructor(adapter: StorageAdapter) {
    this.adapter = adapter;
  }

  async indexRecord(collection: string, record: any, searchableFields: string[]): Promise<void> {
    const tokens = this.#extractTokens(record, searchableFields);
    if (tokens.length === 0) return;

    for (const token of tokens) {
      const indexKey = `${collection}:${token}`;
      const existing = await this.adapter.findById('_ctrodb_fts', indexKey);

      if (existing) {
        if (!existing.docIds.includes(record.id)) {
          existing.docIds.push(record.id);
          await this.adapter.update('_ctrodb_fts', indexKey, { docIds: existing.docIds });
        }
      } else {
        await this.adapter.create('_ctrodb_fts', {
          id: indexKey,
          token,
          collection,
          docIds: [record.id],
        });
      }
    }
  }

  async removeRecord(collection: string, record: any, searchableFields: string[]): Promise<void> {
    const tokens = this.#extractTokens(record, searchableFields);

    for (const token of tokens) {
      const indexKey = `${collection}:${token}`;
      const existing = await this.adapter.findById('_ctrodb_fts', indexKey);

      if (existing) {
        existing.docIds = existing.docIds.filter((id: ID) => id !== record.id);
        if (existing.docIds.length > 0) {
          await this.adapter.update('_ctrodb_fts', indexKey, { docIds: existing.docIds });
        } else {
          await this.adapter.delete('_ctrodb_fts', indexKey);
        }
      }
    }
  }

  async updateRecord(
    collection: string,
    oldRecord: any,
    newRecord: any,
    searchableFields: string[]
  ): Promise<void> {
    const oldTokens = this.#extractTokens(oldRecord, searchableFields);
    const newTokens = this.#extractTokens(newRecord, searchableFields);

    const tokensToAdd = newTokens.filter(t => !oldTokens.includes(t));
    const tokensToRemove = oldTokens.filter(t => !newTokens.includes(t));

    // Remove old tokens
    for (const token of tokensToRemove) {
      const indexKey = `${collection}:${token}`;
      const existing = await this.adapter.findById('_ctrodb_fts', indexKey);
      if (existing) {
        existing.docIds = existing.docIds.filter((id: ID) => id !== newRecord.id);
        if (existing.docIds.length > 0) {
          await this.adapter.update('_ctrodb_fts', indexKey, { docIds: existing.docIds });
        } else {
          await this.adapter.delete('_ctrodb_fts', indexKey);
        }
      }
    }

    // Add new tokens
    for (const token of tokensToAdd) {
      const indexKey = `${collection}:${token}`;
      const existing = await this.adapter.findById('_ctrodb_fts', indexKey);
      if (existing) {
        existing.docIds.push(newRecord.id);
        await this.adapter.update('_ctrodb_fts', indexKey, { docIds: existing.docIds });
      } else {
        await this.adapter.create('_ctrodb_fts', {
          id: indexKey,
          token,
          collection,
          docIds: [newRecord.id],
        });
      }
    }
  }

  async search(collection: string, query: string, searchableFields: string[]): Promise<ID[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    // For each token, find matching doc IDs
    const docIdSets: Set<ID>[] = [];

    for (const token of tokens) {
      const indexKey = `${collection}:${token}`;
      const indexRecord = await this.adapter.findById('_ctrodb_fts', indexKey);
      docIdSets.push(new Set(indexRecord?.docIds || []));
    }

    // Intersection: only docs that match ALL tokens
    const [first, ...rest] = docIdSets;
    if (!first) return [];

    const result = [...first].filter(id => rest.every(set => set.has(id)));
    return result;
  }

  #extractTokens(record: any, searchableFields: string[]): string[] {
    const allTokens = new Set<string>();
    for (const field of searchableFields) {
      const value = record[field];
      if (typeof value === 'string') {
        const tokens = tokenize(value);
        for (const t of tokens) allTokens.add(t);
      }
    }
    return [...allTokens];
  }
}
```

### FTS Plugin Registration

```typescript
function ftsPlugin(): CtroDBPlugin {
  let indexer: FTSIndexer;
  let searchableFieldsMap: Map<string, string[]> = new Map();

  return {
    name: 'fts',
    version: '1.0.0',

    onDatabaseInit(db: Database) {
      indexer = new FTSIndexer(db._getAdapter());
    },

    onCollectionInit(collection: Collection) {
      const schema = collection._getSchema();
      if (schema?.searchable && schema.searchable.length > 0) {
        searchableFieldsMap.set(collection.name, schema.searchable);
      }
    },

    onBeforeCreate(collection: string, data: any): any {
      return data; // No modification needed
    },

    onAfterCreate(collection: string, record: any) {
      const fields = searchableFieldsMap.get(collection);
      if (fields) {
        indexer.indexRecord(collection, record, fields);
      }
    },

    onBeforeUpdate(collection: string, id: any, changes: any): any {
      return changes;
    },

    // The actual `search()` query method is handled by the QueryBuilder
    // The FTS plugin hooks into the adapter's query execution to transform
    // search conditions into ID lookups
  };
}
```

### Scoring (Future Enhancement)

For v3.1+, implement TF-IDF or BM25 scoring:

```typescript
function bm25(
  termFrequency: number,
  docLength: number,
  avgDocLength: number,
  totalDocs: number,
  docsWithTerm: number,
  k1 = 1.2,
  b = 0.75
): number {
  const idf = Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
  const tf = (termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + b * (docLength / avgDocLength)));
  return idf * tf;
}
```

---

## Plugin 2: Relations

### Overview

Adds `has_many`, `belongs_to`, and `has_one` relationships to models. Relationships are lazy-loaded — accessing a relation property returns a QueryBuilder.

### Implementation

```typescript
interface RelationDefinition {
  type: 'has_many' | 'belongs_to' | 'has_one';
  collection: string;
  foreignKey: string;
}

class RelationsPlugin {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Called when a Model is created — adds relation getters */
  attachRelations(model: Model<any>, collectionName: string): void {
    const schema = this.db._getSchema();
    const collectionSchema = schema?.collections?.[collectionName];
    const relations = collectionSchema?.relations;
    if (!relations) return;

    for (const [name, def] of Object.entries(relations)) {
      Object.defineProperty(model, name, {
        get: () => {
          const relatedCollection = this.db.collection(def.collection);

          if (def.type === 'has_many') {
            return relatedCollection.query().where(
              def.foreignKey as any,
              '==' as any,
              model.id as any
            );
          }

          if (def.type === 'belongs_to') {
            const foreignKeyValue = (model as any)[def.foreignKey];
            return relatedCollection.query().where('id' as any, '==' as any, foreignKeyValue);
          }

          if (def.type === 'has_one') {
            return relatedCollection.query()
              .where(def.foreignKey as any, '==' as any, model.id as any)
              .first();
          }

          return undefined;
        },
        configurable: true,
        enumerable: true,
      });
    }
  }

  /** Eager loading — include relations in query results */
  async eagerLoad(
    models: Model<any>[],
    collectionName: string,
    relationsToLoad: string[]
  ): Promise<void> {
    const schema = this.db._getSchema();
    const collectionSchema = schema?.collections?.[collectionName];
    if (!collectionSchema?.relations) return;

    for (const relationName of relationsToLoad) {
      const def = collectionSchema.relations[relationName];
      if (!def) continue;

      if (def.type === 'belongs_to') {
        // Batch load: collect all foreign keys, load related records, assign
        const foreignKeys = models
          .map(m => (m as any)[def.foreignKey])
          .filter((id): id is ID => id != null);

        const relatedRecords = await this.db.collection(def.collection)
          .query()
          .where('id' as any, 'in' as any, foreignKeys)
          .fetch();

        const relatedMap = new Map(relatedRecords.map(r => [r.id, r]));

        for (const model of models) {
          const fk = (model as any)[def.foreignKey];
          (model as any)[`_${relationName}`] = relatedMap.get(fk);
        }
      }

      if (def.type === 'has_many') {
        // Batch load: load all related records, group by foreign key
        const ids = models.map(m => m.id).filter(Boolean);
        const relatedRecords = await this.db.collection(def.collection)
          .query()
          .where(def.foreignKey as any, 'in' as any, ids)
          .fetch();

        const groupedMap = new Map<ID, Model<any>[]>();
        for (const record of relatedRecords) {
          const fk = (record as any)[def.foreignKey];
          if (!groupedMap.has(fk)) groupedMap.set(fk, []);
          groupedMap.get(fk)!.push(record);
        }

        for (const model of models) {
          (model as any)[`_${relationName}`] = groupedMap.get(model.id) || [];
        }
      }
    }
  }
}

function relationsPlugin(): CtroDBPlugin {
  let plugin: RelationsPlugin;

  return {
    name: 'relations',
    version: '1.0.0',

    onDatabaseInit(db: Database) {
      plugin = new RelationsPlugin(db);
    },

    // Relations are attached to models via Model's constructor
    // Model calls plugin.attachRelations(model, collectionName) after creation
  };
}
```

---

## Plugin 3: Validation

### Overview

Adds runtime data validation against the schema at create/update time. Throws helpful `ValidationError` with details.

### Implementation

```typescript
class ValidationPlugin {
  validate(collectionName: string, data: any, schema: SchemaConfig): void {
    const collectionSchema = schema.collections?.[collectionName];
    if (!collectionSchema) return;

    const errors: string[] = [];

    for (const [fieldName, definition] of Object.entries(collectionSchema.fields)) {
      const value = data[fieldName];

      // Required check
      if (definition.required && (value === undefined || value === null)) {
        errors.push(`Field "${fieldName}" is required in collection "${collectionName}".`);
        continue;
      }

      if (value === undefined) continue;

      // Type check
      if (typeof value !== definition.type) {
        errors.push(
          `Field "${fieldName}" in collection "${collectionName}" must be of type "${definition.type}". Got: "${typeof value}".`
        );
        continue;
      }

      // String validations
      if (definition.type === 'string') {
        if (definition.maxLength !== undefined && value.length > definition.maxLength) {
          errors.push(
            `Field "${fieldName}" in collection "${collectionName}" exceeds max length ${definition.maxLength}. Got ${value.length} characters.`
          );
        }

        if (definition.validate === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          errors.push(
            `Field "${fieldName}" in collection "${collectionName}" must be a valid email address. Got: "${value}".`
          );
        }

        if (definition.validate === 'url') {
          try { new URL(value); } catch {
            errors.push(
              `Field "${fieldName}" in collection "${collectionName}" must be a valid URL. Got: "${value}".`
            );
          }
        }

        if (definition.validate instanceof RegExp && !definition.validate.test(value)) {
          errors.push(
            `Field "${fieldName}" in collection "${collectionName}" failed regex validation.`
          );
        }
      }

      // Number validations
      if (definition.type === 'number') {
        if (definition.min !== undefined && value < definition.min) {
          errors.push(
            `Field "${fieldName}" in collection "${collectionName}" must be >= ${definition.min}. Got: ${value}.`
          );
        }
        if (definition.max !== undefined && value > definition.max) {
          errors.push(
            `Field "${fieldName}" in collection "${collectionName}" must be <= ${definition.max}. Got: ${value}.`
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors.join('\n'));
    }
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function validationPlugin(): CtroDBPlugin {
  const plugin = new ValidationPlugin();

  return {
    name: 'validation',
    version: '1.0.0',

    onBeforeCreate(collection: string, data: any): any {
      const db: Database = (this as any).db;
      const schema = db._getSchema();
      if (schema) {
        plugin.validate(collection, data, schema);
      }
      return data;
    },

    onBeforeUpdate(collection: string, id: any, changes: any): any {
      const db: Database = (this as any).db;
      const schema = db._getSchema();
      if (schema) {
        plugin.validate(collection, changes, schema);
      }
      return changes;
    },
  };
}

function validationPlugin(): CtroDBPlugin {
  const plugin = new ValidationPlugin();
  let dbRef: Database | null = null;

  return {
    name: 'validation',
    version: '1.0.0',

    onDatabaseInit(db: Database) {
      dbRef = db;
    },

    onBeforeCreate(collection: string, data: any): any {
      const schema = dbRef?._getSchema();
      if (schema) {
        plugin.validate(collection, data, schema);
      }
      return data;
    },

    onBeforeUpdate(collection: string, id: any, changes: any): any {
      const schema = dbRef?._getSchema();
      if (schema) {
        plugin.validate(collection, changes, schema);
      }
      return changes;
    },
  };
}
```

---

## Plugin 4: Encryption (Future)

### Overview

Provides client-side encryption at rest for sensitive fields. Uses the Web Crypto API (browser) or Node's crypto module.

```typescript
interface EncryptionPluginConfig {
  key: CryptoKey | string;       // Encryption key
  fields: Record<string, string[]>;  // { collectionName: ['field1', 'field2'] }
}

function encryptionPlugin(config: EncryptionPluginConfig): CtroDBPlugin {
  // Encrypt specified fields on create/update
  // Decrypt them on read/query results
  // Uses AES-GCM via Web Crypto API
  return {
    name: 'encryption',
    version: '1.0.0',
    // Hook implementations...
  };
}
```

---

## Plugin Loading

```typescript
class Database {
  #plugins: CtroDBPlugin[] = [];

  constructor(config: DatabaseConfig) {
    // ...
    if (config.plugins) {
      for (const plugin of config.plugins) {
        this.#loadPlugin(plugin);
      }
    }
  }

  #loadPlugin(plugin: CtroDBPlugin): void {
    this.#plugins.push(plugin);
    plugin.onDatabaseInit?.(this);

    // For each existing collection, call onCollectionInit
    this.#collections.forEach((collection, name) => {
      plugin.onCollectionInit?.(collection);
    });
  }

  // Hook execution wrappers
  #runBeforeCreateHooks(collection: string, data: any): any {
    for (const plugin of this.#plugins) {
      if (plugin.onBeforeCreate) {
        data = plugin.onBeforeCreate(collection, data) || data;
      }
    }
    return data;
  }

  #runAfterCreateHooks(collection: string, record: any): void {
    for (const plugin of this.#plugins) {
      plugin.onAfterCreate?.(collection, record);
    }
  }
}
```

## Plugin Priority & Execution Order

Plugins are executed in the order they are provided in the config. This matters when multiple plugins modify data:

```typescript
const db = new Database('myapp', {
  schema: mySchema,
  plugins: [
    validationPlugin(),     // 1. Validate data first
    encryptionPlugin(),     // 2. Then encrypt sensitive fields
    ftsPlugin(),            // 3. Update FTS index
    relationsPlugin(),      // 4. Set up relations (no data modification)
  ],
});
```
