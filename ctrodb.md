# ctrodb — Full Audit & Fix Guide

> Written for an AI agent. Each issue has: reproduction steps, root cause analysis, impact on Formit, and specific fix instructions.

---

## ISSUE 1: FTS Plugin Crashes on Schema Version Bump

### Severity: CRITICAL

### Reproduction
1. Define a ctrodb schema with `version: 1` and a collection with `searchable: ["title"]`
2. Create a `Database` with `ftsPlugin()` registered under `plugins:`
3. Create some records (FTS index stores are created in IndexedDB)
4. Bump schema to `version: 2` (e.g., add a new field)
5. Restart the app
6. Every write operation throws: `"Object store '_ctrodb_fts' not found"`

### Root Cause
File: `src/adapter/idb.ts`, function `createMigrationHandler` (line 23-48)

When `indexedDB.open(dbName, version)` is called with a higher version, IndexedDB fires `onupgradeneeded`. The migration handler (`createMigrationHandler`) creates object stores for each collection in the schema — but **only for stores listed in the schema**. The FTS plugin stores its data in a collection called `"_ctrodb_fts"` (see `src/plugins/fts/indexer.ts` line 4: `const FTS_STORE = "_ctrodb_fts"`). This store is **not part of the schema config**, so it is **not included in `onupgradeneeded`**.

IndexedDB behavior: when `onupgradeneeded` runs, **any existing object store NOT listed in the new schema is silently dropped**. This is a fundamental IndexedDB design rule. After the upgrade, `_ctrodb_fts` no longer exists, so the FTS indexer's `this.#adapter.findById(FTS_STORE, ...)` calls fail.

### Impact on Formit
Formit had to **completely remove the FTS plugin**. This means searchable fields (`apps.name`, `apps.description`, `forms.title`, `forms.description`) are dead config — they exist in the schema but are never used. No full-text search anywhere in the app.

### Fix Instructions
**Option A: Register FTS stores in migration handler (recommended)**

In `src/adapter/idb.ts`, in `createMigrationHandler`, add logic to preserve non-schema stores:

```typescript
function createMigrationHandler(schema: SchemaConfig | null, pluginStoreNames: string[] = []) {
  return function onUpgrade(db: IDBDatabase, _oldVersion: number): void {
    // Create schema-defined stores
    if (schema) {
      for (const [collectionName, collectionSchema] of Object.entries(schema.collections)) {
        if (!db.objectStoreNames.contains(collectionName)) {
          // ... existing creation logic
        }
      }
    }

    // Create plugin stores if they don't exist
    for (const storeName of pluginStoreNames) {
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: "id" })
      }
    }

    // Create meta store
    if (!db.objectStoreNames.contains("_ctrodb_meta")) {
      db.createObjectStore("_ctrodb_meta", { keyPath: "id" })
    }
  }
}
```

Then pass plugin store names from the Database class constructor.

**Option B: Add `onSchemaUpgrade` hook to CtroDBPlugin interface (more flexible)**

In `src/types.ts`, add to `CtroDBPlugin`:
```typescript
onSchemaUpgrade?(db: IDBDatabase, oldVersion: number, newVersion: number): void
```

In `src/database.ts`, collect plugin `onSchemaUpgrade` handlers and pass them to the adapter's `connect` method so they can run inside the `onupgradeneeded` transaction.

**Option C: Store FTS data inside a single schema-manged store**

Instead of using `_ctrodb_fts` as a separate store, store FTS entries as a regular collection in the schema. Add it automatically when `ftsPlugin()` is registered.

---

## ISSUE 2: Validation Plugin Rejects Empty Strings on Non-Required Fields

### Severity: HIGH

### Reproduction
1. Define a schema with a field: `description: { type: "string", default: "" }`
2. Register `validationPlugin()` under `plugins:`
3. Create a record without providing a value for `description` (expecting default `""` to apply)
4. `Schema.applyDefaults()` sets `description = ""`
5. `Schema.validate()` passes (field is not required)
6. The validation plugin's `onBeforeCreate` hook runs `engine.validateRecord()`
7. The built-in `noEmptyStrings` rule fires: `"Field \"description\" cannot be empty."`
8. `create()` throws: `"Validation failed: Field \"description\" cannot be empty."`

### Root Cause
File: `src/plugins/validation/index.ts`, lines 86-94

```typescript
{
  name: "noEmptyStrings",
  validate(_collection: string, field: string, value: unknown, _data: Record<string, unknown>) {
    if (typeof value === "string" && value.trim().length === 0) {
      return `Field "${field}" cannot be empty.`
    }
    return null
  },
}
```

This rule is registered as a **built-in** rule in the `BUILTIN_RULES` array (line 56). It runs for **every** string value, regardless of whether the field is required. The validation plugin runs `validateRecord()` which validates **all keys in the data** (line 48: `validateAll(collection, data, Object.keys(data))`).

Order of operations in `Collection.create()` (file `src/collection.ts` lines 46-72):
1. `runHook("onBeforeCreate")` — validation plugin runs HERE, before defaults are applied
2. `schema.applyDefaults()` — defaults are applied HERE
3. `schema.validate()` — schema validation runs HERE

So even if defaults were applied, the validation plugin already checked the original (undefined) value. But wait — `onBeforeCreate` runs before defaults. If `description` was not provided, it's `undefined`, not an empty string. The `noEmptyStrings` rule only fires on strings. So the actual scenario is:
- User provides `description: ""` explicitly (empty string) → `noEmptyStrings` rejects it
- Or: user omits `description`, defaults are applied via `applyDefaults` → but this happens AFTER `onBeforeCreate`, so the plugin sees `undefined` (which passes)

The actual bug scenario in Formit was: a form had `description: ""` explicitly set (or the user submitted a response with an empty string). The validation plugin rejected it because `noEmptyStrings` catches ALL empty strings, including empty optional fields.

### Impact on Formit
Formit had to **completely remove the validation plugin**. The schema-level validation in `Schema.validate()` is sufficient for type/required checks. But the plugin's `noEmptyStrings` rule made it impossible to have optional string fields with empty values — a very common pattern (empty descriptions, blank optional answers, etc.).

### Fix Instructions
**Option A: Only apply `noEmptyStrings` when field is required (recommended)**

Modify the `noEmptyStrings` rule to receive schema context so it can check `def.required`:
```typescript
{
  name: "noEmptyStrings",
  validate(_collection: string, field: string, value: unknown, data: Record<string, unknown>) {
    if (typeof value === "string" && value.trim().length === 0) {
      // Check if field is required in schema
      return `Field "${field}" cannot be empty.`
    }
    return null
  },
}
```

The problem is the rule doesn't have access to the schema. Fix: pass schema info to the validate function signature, or change the validation plugin to accept the schema reference.

**Option B: Make `noEmptyStrings` opt-in, not built-in**

Remove `noEmptyStrings` from `BUILTIN_RULES`. Users who want it can add it via custom rules.

**Option C: Change validation plugin to run after `applyDefaults`**

Move the `onBeforeCreate` hook to run after defaults are applied. This requires modifying the `runHook` call order in `Collection.create()`:
- Current order: `onBeforeCreate` → `applyDefaults` → `validate`
- Fixed order: `applyDefaults` → `onBeforeCreate` → `validate`

But this changes the plugin contract — `onBeforeCreate` can modify data, and it should see the final data after defaults.

---

## ISSUE 3: `useQuery` Returns Bare Array With No Loading State

### Severity: HIGH

### Reproduction
1. Call `useQuery<Form>("forms")` in a component
2. On first render, the function returns `[]` (empty array)
3. After the query resolves (async), the component re-renders with actual data
4. **The component cannot distinguish between "loading" and "empty results"**

### Root Cause
File: `src/react.ts`, lines 45-87

```typescript
export function useQuery<T extends Record<string, unknown>>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  deps: unknown[] = [],
): Array<Model<T> & T> {
  const db = useDatabase()
  const [results, setResults] = useState<Array<Model<T> & T>>([])
  // ... effect runs query, sets results
  return results  // ← bare array, no metadata
}
```

The initial state is `[]` (line 51). The query runs asynchronously in a `useEffect`. During the async gap, the component renders with an empty array. The component has no way to know if data is still loading or truly empty.

### Impact on Formit
Formit works around this with a manual `ready` state flag in `main.tsx`:
```typescript
const [ready, setReady] = useState(false)
// ... init DB, then setReady(true)
if (!ready) return <p>Initializing...</p>
```

This only covers the initial DB init, not subsequent queries. Every page that uses `useQuery` cannot show loading skeletons — they see a flash of the empty state, then data arrives. This is especially bad on slow connections or large datasets.

In `useApps.ts`, `useForms.ts`, `useResponses.ts`: the components check `apps.length === 0` / `forms.length === 0` / `responses.length === 0` to show empty states, but these also trigger during loading.

### Fix Instructions
**Change return type to include loading and error state.**

In `src/react.ts`, change `useQuery`:

```typescript
export function useQuery<T extends Record<string, unknown>>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  deps: unknown[] = [],
): { data: Array<Model<T> & T>; loading: boolean; error: Error | undefined } {
  const db = useDatabase()
  const [results, setResults] = useState<Array<Model<T> & T>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | undefined>()

  const queryFnRef = useRef(queryFn)
  queryFnRef.current = queryFn

  useEffect(() => {
    const collection = db.collection<T>(collectionName)
    let cancelled = false

    async function runQuery() {
      setLoading(true)
      setError(undefined)
      let query = collection.query()
      if (queryFnRef.current) {
        query = queryFnRef.current(query)
      }
      try {
        const data = await query.fetch()
        if (!cancelled) setResults(data)
      } catch (e) {
        if (!cancelled) setError(e as Error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    runQuery()
    // ... existing change listener
  }, [collectionName, db, ...deps])

  return { data: results, loading, error }
}
```

Also update `useDoc` to return `{ data, loading, error }` instead of bare value.

**Backward compatibility**: Export a separate `useQueryWithState` or add a `useQueryV2` alongside the old one during a migration period.

---

## ISSUE 4: Sync Engine Only Pulls `forms` Collection

### Severity: HIGH

### Reproduction
1. Make a change to an `apps` or `responses` document on one device
2. Wait for sync on another device
3. The `apps` and `responses` changes never appear on the other device

### Root Cause
File: `src/db/sync.ts` (Formit), lines 184-210

```typescript
private async pullRemote(): Promise<void> {
  // ...
  const col = collection(this.firestoreDb, "users", this.userId, "forms")  // ← HARDCODED to "forms"
  const q = query(col, where("updatedAt", ">=", this.getLastSyncTime()))
  // ...
}
```

The pull logic only syncs the `forms` collection. `apps` and `responses` are never pulled from Firestore. Changes made on other devices to these collections are silently lost.

### Impact on Formit
Apps and responses are write-only from the local device. Changes made on the web UI (e.g., via a future admin panel) or on other devices are never synced down for these collections. Only forms have two-way sync.

### Fix Instructions
Replace the hardcoded string with a configurable list of collections:

```typescript
private readonly syncableCollections = ["apps", "forms", "responses"]

private async pullRemote(): Promise<void> {
  if (!this.userId) return
  this.isPulling = true
  try {
    for (const collectionName of this.syncableCollections) {
      const col = collection(this.firestoreDb, "users", this.userId, collectionName)
      const q = query(col, where("updatedAt", ">=", this.getLastSyncTime()))
      const snapshot = await getDocs(q)

      for (const fireDoc of snapshot.docs) {
        const raw = fireDoc.data() as Record<string, unknown>
        const data = fromFirestoreDoc(raw)
        const localCol = this.db.collection(collectionName)
        const existing = await localCol.get(fireDoc.id).catch(() => null)
        if (existing) {
          await localCol.update(fireDoc.id, data)
        } else {
          await localCol.create({ id: fireDoc.id, ...data })
        }
      }
    }
  } catch (err) {
    console.warn("Pull remote failed:", err)
  } finally {
    this.isPulling = false
  }
}
```

Also: the `sync_queue` collection should NEVER be pushed or pulled. The `onLocalChange` already skips it (line 262-263), but the push loop should also guard against it.

---

## ISSUE 5: No Persistent Sync Cursor (Always Last 5 Minutes)

### Severity: MEDIUM

### Reproduction
1. Device syncs at time T
2. No changes occur for hours
3. Device goes offline for 30+ minutes
4. Remote changes were made during offline period
5. Device comes back online
6. Sync fires: `getLastSyncTime()` returns `now - 5min`
7. **Only changes in the last 5 minutes are pulled. Changes made 6+ minutes ago are missed.**

If offline for more than 5 minutes, there is a window of missed changes.

### Root Cause
File: `src/db/sync.ts` (Formit), lines 241-243

```typescript
private getLastSyncTime(): Date {
  return new Date(Date.now() - 5 * 60 * 1000)  // ← always 5 minutes ago
}
```

This is a heuristic, not a real cursor. Every sync recalculates the window as "now minus 5 minutes". There is no persistent store of "last successful sync timestamp".

### Impact on Formit
If a user's device is offline for more than 5 minutes, remote changes made during that offline period are never pulled. The 5-minute window is a fragile assumption that breaks under real-world conditions (long meetings, airplane mode, poor connectivity).

### Fix Instructions
Save the last sync timestamp persistently using ctrodb's metadata API:

```typescript
private async getLastSyncTime(): Promise<Date> {
  const lastSync = await this.db._getAdapter().getMetadata("lastSyncTime")
  if (typeof lastSync === "number") {
    return new Date(lastSync)
  }
  // First sync: use a reasonable default
  return new Date(Date.now() - 24 * 60 * 60 * 1000)  // last 24 hours
}

private async updateLastSyncTime(): Promise<void> {
  await this.db._getAdapter().setMetadata("lastSyncTime", Date.now())
}
```

Call `updateLastSyncTime()` after a successful pull (in the `finally` block of `pullRemote()`, after `isPulling = false`).

---

## ISSUE 6: Race Condition During Pull — Local Changes Silently Dropped

### Severity: MEDIUM

### Reproduction
1. User makes a local edit (e.g., updates a form title)
2. Sync fires and `pullRemote()` starts
3. `isPulling` is set to `true`
4. The local edit from step 1 triggers `db.on()` → `onLocalChange()`
5. `onLocalChange()` checks `if (this.isPulling) return` — **the local change is skipped**
6. The local edit is never queued for sync

### Root Cause
File: `src/db/sync.ts` (Formit), lines 187 and 261-268

```typescript
// In pullRemote():
this.isPulling = true

// In onLocalChange():
onLocalChange(event: ChangeEvent): void {
  if (this.isPulling) return  // ← local changes during pull are silently dropped
  // ...
}
```

The `isPulling` flag is meant to prevent re-queueing changes that were just pulled from remote (to avoid infinite loops). But it also blocks legitimate local changes that happen to occur during the pull window.

### Impact on Formit
Local edits made during the ~1-5 second window of `pullRemote()` are silently lost. They are not synced to Firestore. This is a data loss bug, albeit in a narrow time window.

### Fix Instructions
Replace the boolean flag with a more precise deduplication mechanism:

**Option A: Timestamp-based dedup (recommended)**

Instead of `isPulling`, track which record IDs were just pulled:

```typescript
private justPulled = new Set<string>()

// In pullRemote(), for each pulled doc:
this.justPulled.add(`${collectionName}:${fireDoc.id}`)

// In onLocalChange():
if (this.justPulled.has(`${event.collection}:${event.recordId}`)) {
  this.justPulled.delete(`${event.collection}:${event.recordId}`)
  return  // skip — this is a re-queue of a just-pulled change
}
// Otherwise, queue normally
```

Clear the set after pull completes: `this.justPulled.clear()`

**Option B: Queue with a flag**

In `queueChange()`, add a parameter `isFromPull = false`. Set it to true for pulled changes. In `pushPending()`, skip items with `isFromPull`.

---

## ISSUE 7: No Conflict Resolution — Last-Write-Wins

### Severity: MEDIUM

### Description
The sync engine uses simple last-write-wins semantics in both directions:
- **Push**: overwrites the Firestore document with local data
- **Pull**: overwrites the local IndexedDB document with remote data

There is no merge logic. If the same document is edited on two devices between syncs, one edit is silently lost.

### Fix Instructions
Implement a simple vector clock or timestamp-based merge:

```typescript
// In pushItem(), only push if local version is newer:
const remoteRef = doc(this.firestoreDb, firestorePath)
const remoteSnap = await getDoc(remoteRef)
if (remoteSnap.exists()) {
  const remoteData = remoteSnap.data() as Record<string, unknown>
  if (remoteData.updatedAt && remoteData.updatedAt > item.data?.updatedAt) {
    return  // remote is newer, skip push (will be pulled instead)
  }
}
await setDoc(remoteRef, { ...item.data, updatedAt: Timestamp.now() })
```

This is a minimal fix. For true conflict resolution, implement CRDT or operational transform — but that's a significant feature, not a bug fix.

---

## ISSUE 8: No Cleanup of `sync_queue` — Accumulates Forever

### Severity: LOW

### Reproduction
1. Use the app for a week, making many changes
2. The `sync_queue` collection fills with thousands of `completed` + `failed` items
3. `updatePendingCount()` queries ALL completed items every sync cycle
4. Performance degrades over time

### Root cause
File: `src/db/sync.ts` (Formit) — items are created with `status: "pending"`, updated to `"completed"` or `"failed"`, but never deleted.

### Fix Instructions
Add a cleanup step in `sync()`:

```typescript
async function cleanup() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const oldItems = await this.db
    .collection<SyncQueueItem>("sync_queue")
    .query()
    .where("timestamp", "<", weekAgo)
    .fetch()
  for (const item of oldItems) {
    await this.db.collection("sync_queue").delete(item.id)
  }
}
```

Call `cleanup()` periodically (e.g., every 100th sync) or on app start.

---

## ISSUE 9: Orphaned `syncing` Items After Crash

### Severity: LOW

### Reproduction
1. Sync starts, sets item status to `"syncing"` (sync.ts line 152)
2. App crashes before the item completes (before line 155)
3. On next app start, the item is stuck in `"syncing"` state forever
4. `getPendingItems()` only queries `status: "pending"`, so the stuck item is never retried

### Root Cause
File: `src/db/sync.ts` (Formit), lines 147-165

Items are set to `"syncing"` before the actual push, but if the push crashes or the app terminates, the status never changes. There's no recovery path.

### Fix Instructions
On sync engine start, reset all `"syncing"` items back to `"pending"`:

```typescript
async start(userId: string): Promise<void> {
  // Reset orphaned items
  await this.resetOrphanedItems()
  // ... existing logic
}

private async resetOrphanedItems(): Promise<void> {
  const stuckItems = await this.db
    .collection<SyncQueueItem>("sync_queue")
    .query()
    .where("status", "syncing")
    .fetch()
  for (const item of stuckItems) {
    await this.db.collection("sync_queue").update(item.id, { status: "pending" })
  }
}
```

---

## ISSUE 10: No Exponential Backoff for Sync Retries

### Severity: LOW

### Reproduction
1. A sync item fails (e.g., Firestore is unreachable)
2. Every 30 seconds, it retries
3. If the network is still down, it keeps retrying every 30 seconds
4. After 5 retries (`>= 5`), it marks as `"failed"` permanently — never retried again

### Root Cause
File: `src/db/sync.ts` (Formit), lines 156-162

```typescript
const retry = item.retryCount + 1
if (retry >= 5) {
  await this.updateItemStatus(item.id, "failed")
} else {
  await this.updateItemRetry(item.id, retry)  // sets status back to "pending"
}
```

Fixed 30-second interval regardless of retry count. After 5 failures, the item is never retried again (permanent failure).

### Fix Instructions
Add exponential backoff and infinite retry (with very long intervals):

```typescript
const BACKOFF_DELAYS = [10, 30, 60, 120, 300, 600, 1800]  // seconds
// First retry: 10s, second: 30s, third: 1min, fourth: 2min, etc.

const retry = item.retryCount + 1
const delay = (BACKOFF_DELAYS[Math.min(retry, BACKOFF_DELAYS.length - 1)] ?? 3600) * 1000
const minTime = item.timestamp + delay

if (Date.now() < minTime) {
  continue  // skip this sync cycle, wait for backoff
}

await this.updateItemRetry(item.id, retry)  // status stays "pending"
```

Remove the "permanent failure after 5 retries" logic. Failed items should always be retryable (or have a manual "retry now" button).

---

## ISSUE 11: `Partial<T>` on `create()` Lacks Compile-Time Safety

### Severity: LOW (runtime safety is covered by schema)

### Root Cause
File: `src/collection.ts` (ctrodb), line 46

```typescript
async create(data: Partial<T>): Promise<Model<T> & T>
```

`Partial<T>` makes ALL fields optional at compile time. Required schema fields (`def.required = true`) are only enforced at runtime in `Schema.validate()`.

### Formit Workaround
Every `create()` call manually constructs the object with all required fields, then casts with `as Partial<Form>`:

```typescript
return create({
  id: generateId(),
  appId,
  title: data.title,
  // ... all required fields explicitly set
} as Partial<Form>)
```

The `as Partial<Form>` cast suppresses any TypeScript errors.

### Fix Instructions
Provide a stricter input type:

```typescript
async create(data: Omit<T, "id"> & { id?: string }): Promise<Model<T> & T>
```

This ensures all fields from `T` are required except `id` (which is optional — can be auto-generated). For a truly type-safe approach, generate input types from the schema definition, but that requires a code generator.

---

## ISSUE 12: IndexedDB `autoIncrement` vs String IDs (nanoid)

### Severity: MEDIUM

### Reproduction
1. Create a record with an explicit string `id` (e.g., `generateId()` which returns nanoid)
2. IndexedDB stores it correctly (the provided `id` overrides autoIncrement)
3. Create another record WITHOUT providing an `id`
4. IndexedDB generates a numeric auto-increment ID (e.g., `1`, `2`)
5. Now the collection has mixed `string | number` IDs
6. Functions that assume `string` IDs (e.g., `String(event.recordId)` in sync.ts line 267) work but operations on numeric IDs via `store.get(1)` work differently than `store.get("1")`

### Root Cause
File: `src/adapter/idb.ts` (ctrodb), line 31

```typescript
const store = db.createObjectStore(collectionName, {
  keyPath: "id",
  autoIncrement: true,  // ← always enabled
})
```

When a record is created WITHOUT an `id` field, IndexedDB auto-generates a number. When a record IS created with an `id`, that value is used. The MemoryAdapter has the same behavior (line 48-52 of memory.ts).

Formit always provides explicit string IDs (`generateId()`), so this works. But if any code calls `col.create(data)` without providing an `id`, the resulting numeric ID could cause type mismatches.

### Fix Instructions
**Option A: Remove `autoIncrement: true` since Formit always provides IDs**

In `src/adapter/idb.ts`, change to:
```typescript
const store = db.createObjectStore(collectionName, {
  keyPath: "id",
  autoIncrement: false,  // all IDs must be explicitly provided
})
```

This changes behavior for anyone relying on auto-increment. Update `idbCreate` to require `id`:
```typescript
function idbCreate(db: IDBDatabase, collection: string, data: Record<string, unknown>): Promise<...> {
  if (!data.id) throw new Error("id is required")
  // ...
}
```

**Option B: Keep autoIncrement but add a validation guard**

In `Schema.validate()`, check that `id` type matches a configured `idType: "string" | "number" | "auto"`.

---

## ISSUE 13: QueryPlanner Never Generates `id_lookup` Strategy

### Severity: LOW

### Root Cause
File: `src/query/planner.ts` (ctrodb)

The `id_lookup` strategy is defined in types (line 51 of types.ts: `type QueryStrategy = "index_scan" | "full_scan" | "id_lookup"`) but **the planner never returns this strategy**. Conditions like `q.where("id", "==", someId)` are treated as `index_scan` (if `id` is indexed) or `full_scan`.

`QueryExecutor.execute()` (src/query/executor.ts, line 8) handles `id_lookup` by calling `adapter.findById()`, which is the most efficient path. But since the planner never generates it, this code path is dead.

### Impact on Formit
`useDoc<Form>("forms", formId)` internally uses `q.where("id", formId)`, which does a full scan or index scan instead of the more efficient `findById` path. On large datasets, this is slower.

### Fix Instructions
In `src/query/planner.ts`, in `#planSingleGroup`, add a check for `id == X` conditions:

```typescript
#planSingleGroup(conditions, collectionSchema, indexes): QueryPlan {
  const idCondition = conditions.find(
    (c) => c.field === "id" && c.op === "=="
  )
  if (idCondition && conditions.length === 1) {
    return {
      strategy: "id_lookup",
      primaryConditions: [idCondition],
      postFilterConditions: [],
      groupType: "single",
    }
  }
  // ... rest of existing logic
}
```

---

## ISSUE 14: `setDefaultDatabase` + `DatabaseProvider` Dual API

### Severity: LOW

### Description
File: `src/react.ts` (ctrodb)

Two ways to provide the database instance:
1. `setDefaultDatabase(db)` — sets a global module-level variable (line 15-19)
2. `<DatabaseProvider db={db}>` — React context provider (line 32-35)

The provider ALSO calls `setDefaultDatabase()` internally (line 33), which means:
- If you use the provider, the global is also set (so `useDatabase()` works via context OR global)
- If you use `setDefaultDatabase()` outside the provider, only the global is set
- If you use BOTH, the one called last wins

Confusing API. The `useDatabase()` hook prefers context over global (line 37-43), but falls back to global.

### Impact on Formit
Formit uses `setDefaultDatabase()` in `main.tsx`. This works fine. But the dual API is confusing for new users and the fallback behavior is implicit.

### Fix Instructions
Deprecate `setDefaultDatabase`. Make `DatabaseProvider` the only way to provide the DB instance, and make `useDatabase` throw if no context is available (no fallback to global).

---

## ISSUE 15: Schema Validation Runs After Plugin Hooks (Ordering Bug)

### Severity: LOW

### Root Cause
File: `src/collection.ts` (ctrodb), in `create()` (lines 46-72):

```typescript
async create(data: Partial<T>): Promise<Model<T> & T> {
  let processed = runHook(this.#plugins, "onBeforeCreate", ...) // step 1: plugins
  if (this.#schema) {
    processed = this.#schema.applyDefaults(this.name, processed) // step 2: defaults
    this.#schema.validate(this.name, processed)                  // step 3: schema validation
  }
  const record = await this.#adapter.create(this.name, processed) // step 4: persist
  // ...
}
```

In `update()` (lines 85-113):

```typescript
async update(id: ID, changes: Partial<T>): Promise<Model<T> & T> {
  const existing = ... // step 1: fetch existing
  const processed = runHook(this.#plugins, "onBeforeUpdate", ...) // step 2: plugins
  if (this.#schema) {
    this.#schema.validate(this.name, { ...existing, ...processed }) // step 3: validation
  }
  // ...
}
```

Notice: in `update()`, `runHook("onBeforeUpdate")` runs BEFORE `this.#schema.validate()`. This means the validation plugin (which runs in `onBeforeUpdate` and throws on errors) is checked, then schema validation runs. That's fine.

But in `create()`, `onBeforeCreate` runs BEFORE `applyDefaults()`. The validation plugin's `noEmptyStrings` rule checks empty strings before defaults are applied. Fix described in Issue 2.

---

## ISSUE 16: No Built-in Sync Engine

### Severity: MEDIUM (feature gap)

### Description
ctrodb is described as "offline-first" but ships without any sync mechanism. The entire sync layer in Formit (`src/db/sync.ts`, 270 lines) was built from scratch, including:
- Queue management (pending/syncing/completed/failed)
- Push to Firestore
- Pull from Firestore
- Retry logic
- Connection status tracking
- Firestore timestamp conversion

This is the #1 feature gap for the library. Every user of ctrodb will have to build their own sync engine.

### Fix Instructions
Build a first-party `syncPlugin()` or `SyncEngine` class that:
1. Uses the plugin system (CtroDBPlugin hooks) to auto-queue changes
2. Provides pluggable backends (Firestore, REST API, GraphQL)
3. Handles conflict resolution
4. Provides persistent sync cursor
5. Manages retry with exponential backoff
6. Exposes sync status (pending count, online/offline, last sync time)

---

## ISSUE 17: RelationsPlugin Monkey-Patches Collection via Proxy

### Severity: LOW

### Root Cause
File: `src/plugins/relations/index.ts` (ctrodb), lines 116-145

The `relationsPlugin` wraps `db.collection` with a Proxy that intercepts calls and adds a `.with()` method. This is fragile:
- If `db.collection` is called before the plugin is initialized, the patching doesn't apply
- The `.with()` method patches `QueryBuilder.fetch()` by wrapping it in a new function
- If another plugin also patches `fetch()`, they conflict

### Fix Instructions
Add `.with()` as a first-class method on `QueryBuilder` or `Collection` instead of monkey-patching via plugin.

---

## SUMMARY TABLE

| # | Issue | File(s) | Severity | Fix Complexity |
|---|-------|---------|----------|---------------|
| 1 | FTS plugin crashes on schema version bump | `adapter/idb.ts`, `plugins/fts/` (ctrodb) | CRITICAL | Medium |
| 2 | Validation plugin rejects empty strings | `plugins/validation/index.ts` (ctrodb) | HIGH | Small |
| 3 | `useQuery` returns bare array, no loading state | `react.ts` (ctrodb) | HIGH | Medium |
| 4 | Sync engine only pulls `forms` collection | `db/sync.ts` (Formit) | HIGH | Small |
| 5 | No persistent sync cursor | `db/sync.ts` (Formit) | MEDIUM | Small |
| 6 | Race condition during pull drops local changes | `db/sync.ts` (Formit) | MEDIUM | Small |
| 7 | No conflict resolution (last-write-wins) | `db/sync.ts` (Formit) | MEDIUM | Medium |
| 8 | No sync_queue cleanup | `db/sync.ts` (Formit) | LOW | Small |
| 9 | Orphaned `syncing` items after crash | `db/sync.ts` (Formit) | LOW | Small |
| 10 | No exponential backoff for sync retries | `db/sync.ts` (Formit) | LOW | Small |
| 11 | `Partial<T>` on create lacks compile-time safety | `collection.ts` (ctrodb) | LOW | Small |
| 12 | Mixed numeric/string IDs from autoIncrement | `adapter/idb.ts` (ctrodb) | MEDIUM | Medium |
| 13 | `id_lookup` strategy never generated by planner | `query/planner.ts` (ctrodb) | LOW | Small |
| 14 | `setDefaultDatabase` + `DatabaseProvider` dual API | `react.ts` (ctrodb) | LOW | Small |
| 15 | Schema validation runs after plugin hooks | `collection.ts` (ctrodb) | LOW | Small |
| 16 | No built-in sync engine | — (feature gap) | MEDIUM | Large |
| 17 | RelationsPlugin monkey-patches Collection | `plugins/relations/index.ts` (ctrodb) | LOW | Medium |

## Fix Priority Order

1. **Issues 1-2** (CRITICAL/HIGH in ctrodb library): These are confirmed production bugs that crashed Formit. Fix FTS migration + validation plugin.
2. **Issues 3-5** (HIGH/MEDIUM in Formit code): Fix `useQuery` loading state, pull all collections, persistent sync cursor.
3. **Issues 6-7** (MEDIUM in Formit code): Fix race condition, add basic conflict resolution.
4. **Issues 8-10** (LOW in Formit code): Cleanup, recovery, backoff.
5. **Issues 11-17** (refactoring/features): Compile-time safety, ID strategy, query optimization, API cleanup, sync engine.

## Formit-Specific Dead Code

- `src/db/sync-plugin.ts` — defined but NEVER imported. The sync is wired via `db.on()` in `database.ts` instead. Either remove the file or wire it up.
- FTS plugin and validation plugin — schema defines `searchable` fields, but plugins are never registered.
