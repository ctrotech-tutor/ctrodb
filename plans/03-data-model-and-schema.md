# Plan 03 — Data Model & Schema

## Schema System

The schema is the blueprint for the entire database. It defines:
- What collections exist
- What fields each collection has, and their types
- Indexes for query optimization
- Relations to other collections
- Searchable fields for full-text search

### Schema Definition

```typescript
const schema = {
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: 'string', required: true, maxLength: 100 },
        email: { type: 'string', required: true, validate: 'email', unique: true },
        age: { type: 'number', min: 0, max: 150 },
        role: { type: 'string', default: 'user' },
        tags: { type: 'array', items: { type: 'string' } },
        profile: { type: 'object' },
        createdAt: { type: 'number', default: () => Date.now() },
      },
      indexes: [
        { field: 'email', unique: true },
        { field: 'age' },
      ],
      relations: {
        posts: { type: 'has_many', foreignKey: 'authorId', collection: 'posts' },
      },
      searchable: ['name'],
    },
    posts: {
      fields: {
        title: { type: 'string', required: true },
        content: { type: 'string' },
        authorId: { type: 'number' },
        publishedAt: { type: 'number' },
      },
      indexes: [
        { field: 'authorId' },
        { field: 'publishedAt' },
      ],
      relations: {
        author: { type: 'belongs_to', foreignKey: 'authorId', collection: 'users' },
      },
      searchable: ['title', 'content'],
    },
  },
};
```

### Schema Validation (At Definition Time)

When a schema is defined, the following validations run:

1. **Version**: Must be a positive integer
2. **Collections**: Must have at least one; each must have a name
3. **Fields**: Each collection must have at least one field
4. **Field definitions**:
   - `type`: Must be one of `'string'`, `'number'`, `'boolean'`, `'object'`, `'array'`
   - `required`: Optional boolean (default: false)
   - `validate`: Optional string (`'email'`, `'url'`) or RegExp or function
   - `min`/`max`: Only for `number` type
   - `maxLength`: Only for `string` type
   - `items`: Only for `array` type (defines item schema)
5. **Indexes**:
   - Must reference existing field names
   - Can have `unique: true`
6. **Relations**:
   - `type` must be `'has_many'`, `'belongs_to'`, or `'has_one'`
   - `collection` must reference an existing collection name
   - `foreignKey` must reference an existing field in the related collection
7. **Searchable**: Fields must exist in the collection's field definitions

### Runtime Validation (At Create/Update)

When data is created or updated, runtime validation runs against the schema:

```typescript
function validate(data: any, collectionSchema: CollectionSchema): ValidationResult {
  const errors: ValidationError[] = [];

  for (const [fieldName, definition] of Object.entries(collectionSchema.fields)) {
    const value = data[fieldName];

    // Required check
    if (definition.required && (value === undefined || value === null)) {
      errors.push({ field: fieldName, message: `Field "${fieldName}" is required` });
      continue;
    }

    // Skip if undefined and not required
    if (value === undefined) continue;

    // Type check
    const typeError = checkType(fieldName, value, definition);
    if (typeError) { errors.push(typeError); continue; }

    // Type-specific validations
    if (definition.type === 'string') {
      if (definition.maxLength !== undefined && value.length > definition.maxLength) {
        errors.push({ field: fieldName, message: `Field "${fieldName}" exceeds max length of ${definition.maxLength}` });
      }
    }

    if (definition.type === 'number') {
      if (definition.min !== undefined && value < definition.min) {
        errors.push({ field: fieldName, message: `Field "${fieldName}" must be >= ${definition.min}` });
      }
      if (definition.max !== undefined && value > definition.max) {
        errors.push({ field: fieldName, message: `Field "${fieldName}" must be <= ${definition.max}` });
      }
    }

    // Custom validation
    if (definition.validate) {
      const valid = runValidator(value, definition.validate);
      if (!valid) {
        errors.push({ field: fieldName, message: `Field "${fieldName}" failed validation` });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
```

### Built-in Validators

```typescript
function emailValidator(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function urlValidator(value: string): boolean {
  try { new URL(value); return true; }
  catch { return false; }
}

function regexValidator(value: string, pattern: RegExp): boolean {
  return pattern.test(value);
}
```

### Default Values

Default values are applied at create time if the field is not provided:

```typescript
function applyDefaults(data: any, collectionSchema: CollectionSchema): any {
  const result = { ...data };
  for (const [fieldName, definition] of Object.entries(collectionSchema.fields)) {
    if (result[fieldName] === undefined && definition.default !== undefined) {
      result[fieldName] = typeof definition.default === 'function'
        ? definition.default()
        : definition.default;
    }
  }
  return result;
}
```

### Migration System

Migrations are code-based functions that transform the database from one version to the next:

```typescript
interface Migration {
  version: number;       // Target version after this migration
  description?: string;  // Human-readable description
  up: (ctx: MigrationContext) => Promise<void>;
  down?: (ctx: MigrationContext) => Promise<void>;  // Rollback
}

interface MigrationContext {
  createCollection(name: string, options?: CollectionOptions): void;
  dropCollection(name: string): void;
  addIndex(collection: string, field: string, options?: IndexOptions): void;
  removeIndex(collection: string, field: string): void;
  addField(collection: string, field: string, definition: FieldDefinition): void;
  removeField(collection: string, field: string): void;
  renameCollection(oldName: string, newName: string): void;
  executeSQL?(sql: string): Promise<void>;  // For future SQLite adapter
}
```

### Migration Execution

```typescript
async function runMigrations(
  adapter: StorageAdapter,
  currentVersion: number,
  targetVersion: number,
  migrations: Migration[]
): Promise<void> {
  // Get migrations that need to run (sorted by version)
  const pending = migrations
    .filter(m => m.version > currentVersion && m.version <= targetVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await adapter.transaction(async (ctx) => {
      const migrationCtx = createMigrationContext(ctx);
      await migration.up(migrationCtx);
      await adapter.setMetadata('schemaVersion', migration.version);
    });
  }
}
```

### Schema-less Mode

For developers who want to start without a schema:

```typescript
const db = new Database('myapp');
// No schema — collections are created on first insert
// No validation, no indexes, free-form data
```

When no schema is provided:
- Collections are created dynamically on first `create`
- No type validation (any data is accepted)
- No indexes (queries always use full scan)
- The `id` field is auto-generated
- A warning is logged: "No schema defined. Running in schemaless mode — consider defining a schema for production use."

### Serialization / Deserialization

Records stored in IndexedDB are JSON-serializable. The system handles:

- **Numbers**: Stored as-is (IDB supports numbers natively)
- **Strings**: Stored as-is
- **Booleans**: Stored as-is
- **Objects**: Stored as-is (IDB supports structured clone)
- **Arrays**: Stored as-is
- **Dates**: Converted to timestamps (number) for storage
- **undefined**: Not stored (omitted from record)
- **null**: Stored as null

### Record Structure

Every record stored in IndexedDB has:

```typescript
interface StoredRecord {
  id: ID;                    // Auto-generated or provided (number | string)
  [field: string]: any;      // User-defined fields from schema
}
```

The `id` field is:
- Auto-incrementing integer by default (IDB `autoIncrement: true`)
- Can be user-provided if the field is included in create data
- Must be a number or string
- Unique for the collection
- Immutable after creation

### Metadata Storage

The system uses a special internal collection `_ctrodb_meta` to store:

```typescript
interface MetadataRecord {
  key: string;      // e.g., 'schemaVersion', 'ftsVersion'
  value: any;       // e.g., 1, '2.0'
}
```

This persists:
- Current schema version
- FTS index version
- Any plugin-specific metadata
