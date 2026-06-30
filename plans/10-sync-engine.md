# Plan 10 — Sync Engine

## Table of Contents
1. [Design Principles](#1-design-principles)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Model](#3-data-model)
4. [Phase 1 — Foundation: Types, Queue, ChangeTracker](#4-phase-1--foundation-types-queue-changetracker)
5. [Phase 2 — Conflict Resolver](#5-phase-2--conflict-resolver)
6. [Phase 3 — Sync Orchestrator](#6-phase-3--sync-orchestrator)
7. [Phase 4 — HTTP Transport](#7-phase-4--http-transport)
8. [Phase 5 — Sync Plugin & Database Integration](#8-phase-5--sync-plugin--database-integration)
9. [Phase 6 — React Hooks](#9-phase-6--react-hooks)
10. [Phase 7 — WebSocket Transport](#10-phase-7--websocket-transport)
11. [Phase 8 — Multi-Tab & Background Sync](#11-phase-8--multi-tab--background-sync)
12. [Phase 9 — Inspection, Debugging & Developer Tools](#12-phase-9--inspection-debugging--developer-tools)
13. [Phase 10 — Server SDK & Example Backends](#13-phase-10--server-sdk--example-backends)
14. [Testing Strategy](#14-testing-strategy)
15. [Edge Cases & Error Handling](#15-edge-cases--error-handling)
16. [Performance Considerations](#16-performance-considerations)
17. [Future Work (v2.x)](#17-future-work-v2x)

---

## 1. Design Principles

1. **Plugin-native** — Sync is a first-class plugin, exactly like FTS. It leverages `storeNames`, `onDatabaseInit`, `onAfterCreate/Update/Delete`, and `onCollectionInit` hooks. Zero changes required to existing core internals.

2. **Offline-first** — All mutations are recorded locally first (even when online). The sync queue is persistent via `_ctrodb_sync_changes`. Users get full read/write regardless of connectivity.

3. **Resilient** — Exponential backoff, partial-failure recovery, idempotent push, cursor-based pull. No data loss on crash mid-sync.

4. **Backend-agnostic** — The `SyncTransport` interface abstracts the server. HTTP and WebSocket transports ship built-in. Users implement custom transports for any backend (Supabase, Firebase, Hasura, custom REST/GraphQL).

5. **Deterministic conflict resolution** — LWW by default. Client-wins, server-wins, and custom resolvers available. Every conflict has a deterministic outcome.

6. **Developer-friendly** — Opt-in per collection, auto-sync or manual, React hooks for sync status, event-driven API, inspectable queue.

7. **Zero dependency** — Same as ctrodb core. HTTP transport uses `fetch` (available globally in browsers and Node 18+). WebSocket uses native `WebSocket`.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        User Application                           │
├──────────────────────────────────────────────────────────────────┤
│  React Hooks: useSyncStatus(), useSyncQueue()                    │
├──────────────────────────────────────────────────────────────────┤
│                        Database                                    │
│  .sync() → delegates to SyncEngine                                │
│  .on("sync") → SyncEvent subscription                             │
│  .syncStatus → getter for pending count, last sync, etc.         │
├──────────────────────────────────────────────────────────────────┤
│                        SyncPlugin                                  │
│  onAfterCreate/Update/Delete → ChangeTracker.append()             │
│  onDatabaseInit → SyncEngine.init()                                │
│  onCollectionInit → register synced collections                    │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │                     SyncEngine                                 │ │
│ │                                                                │ │
│ │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │ │
│ │  │ ChangeTracker │  │ConflictRsolvr│  │    Scheduler      │   │ │
│ │  │ (queue mgmt)  │  │ LWW / CW/SW │  │ autoSync timer    │   │ │
│ │  │                │  │ Custom       │  │ backoff mgmt      │   │ │
│ │  └──────┬────────┘  └──────┬───────┘  │ reconnect handler │   │ │
│ │         │                  │           └──────────────────┘   │ │
│ │         │                  │                                   │ │
│ │  ┌──────▼──────────────────▼──────────────────────────────┐  │ │
│ │  │                    SyncTransport                         │  │ │
│ │  │     HttpTransport  |  WsTransport  |  CustomTransport    │  │ │
│ │  └────────────────────────┬────────────────────────────────┘  │ │
│ └───────────────────────────┼──────────────────────────────────┘ │
│                             │                                      │
├─────────────────────────────┼────────────────────────────────────┤
│                        Network                                     │
│                    POST /sync/push                                  │
│                    POST /sync/pull                                  │
│                    WS /sync (realtime)                              │
└─────────────────────────────┴──────────────────────────────────────┘
```

### Data Flow — Create Operation (Online)

```
User:   collection.create({ title: "Hello" })
          │
          ▼
  Collection.create()
          │
          ├── Schema validation
          ├── onBeforeCreate hooks
          ├── Adapter.create() → stored in IndexedDB
          ├── onAfterCreate hooks
          │     └── SyncPlugin.onAfterCreate()
          │           └── ChangeTracker.append({
          │                 type: "create",
          │                 collection: "todos",
          │                 recordId: "abc-123",
          │                 data: { title: "Hello" },
          │                 timestamp: "2026-06-28T12:00:00.000Z",
          │                 status: "pending"
          │               })
          ├── Emit ChangeEvent to signals
          │
          └── SyncEngine (if autoSync):
                ├── debounce 500ms
                ├── read all pending changes
                ├── mark them "syncing"
                ├── SyncTransport.push(changes)
                ├── on accepted → mark "committed"
                ├── on conflict → resolve → mark "committed"
                ├── on error → mark "failed", schedule retry
                ├── SyncTransport.pull(cursor)
                └── apply remote changes locally
```

### Data Flow — Pull (Remote changes applied)

```
SyncEngine.sync() pull phase:
  1. Read lastPullCursor from metadata
  2. SyncTransport.pull(cursor)
  3. For each incoming change:
     a. Check if the record exists locally
     b. If not → adapter.create() (with _syncInProgress flag to skip change tracking)
     c. If yes → compare timestamps:
          - Remote is newer → adapter.update()
          - Local is newer (conflict) → ConflictResolver.resolve()
     d. After applying → set metadata lastPullCursor = server's cursor
  4. Emit SyncEvent with { phase: "pull", applied: n }
```

---

## 3. Data Model

### 3.1 `_ctrodb_sync_changes` Store

Declared via `storeNames: ["_ctrodb_sync_changes"]` in the sync plugin (same pattern as FTS).

```typescript
interface SyncChangeRecord {
  id: string                    // UUID (monotonically increasing, also cursor)
  collection: string            // collection name
  recordId: ID                  // the record that changed
  type: "create" | "update" | "delete"
  data: Record<string, unknown> | null  // snapshot (null for deletes)
  prevData: Record<string, unknown> | null  // previous snapshot (for undo / merge)
  timestamp: string             // ISO 8601, client-generated
  status: "pending" | "syncing" | "committed" | "failed"
  retries: number               // retry count for backoff
  errorMessage: string | null   // last error
  createdAt: string             // ISO 8601
  updatedAt: string             // ISO 8601
}
```

#### Store Design Rationale

- **`id` as UUID timestamp**: We use `crypto.randomUUID()` but we also store the timestamp separately. We considered ULID or timestamp-first UUIDs for cursor ordering, but any UUID works since we sort by the dedicated `timestamp` field (with an index on it).
- **`data` is a snapshot**: For creates/updates, we store the full record at time of mutation. This ensures we push the correct data even if the record changes again before sync.
- **`prevData` for merges**: Helps with conflict resolution (diff-based merging) and undo.
- **`status` state machine**: `pending → syncing → committed | failed`. Transitions are one-directional for a given change (except `failed → pending` on retry).
- **`retries` + `errorMessage`**: Enables exponential backoff and observability.

#### Indexes

In the IndexedDB adapter, we need an index on `status` for querying pending changes and on `timestamp` for ordering. Since the sync engine accesses this store directly via `adapter.findAll()` or `adapter.scanIndex()`, we need to ensure the store supports indexes.

The plugin system currently creates object stores via `db.createObjectStore(storeName, { keyPath: "id" })` without additional indexes. For the sync store, we need to add a `status` index and a `timestamp` index for efficient querying.

**How to handle this**: In `onDatabaseInit`, after the adapter is connected, we check if the sync store has the required indexes. If not (because the schema migration only creates stores without indexes for plugin stores), we create them via the raw IndexedDB API. The sync engine accesses `_ctrodb_sync_changes` through the adapter, so we also need a way to scan by index on plugin stores.

**Alternative approach**: Since the sync plugin manages its own store, it can have its own "adapter on top of the adapter" — a helper class that uses `adapter.getMetadata()` / `adapter.setMetadata()` for sync state and raw adapter CRUD for the sync queue. It doesn't need full query support — just `findAll` filtered by status, sorted by timestamp.

**Simpler approach for v1**: Use `adapter.findAll("_ctrodb_sync_changes")` and filter/sort in memory. The sync queue is typically small (hundreds, not millions). We can optimize with indexes in Phase 8 if needed.

### 3.2 Sync Metadata (stored in `_ctrodb_meta`)

| Key | Value |
|---|---|
| `sync:lastPullCursor` | `string \| null` — last change cursor from server |
| `sync:serverUrl` | `string` — configured server URL |
| `sync:status` | `"idle" \| "syncing" \| "error" \| "offline"` |
| `sync:lastSyncAt` | `string \| null` — ISO 8601 timestamp of last completed sync |

### 3.3 SyncEvent

Emits through `db.on("sync", callback)` and `collection.onChange()`.

```typescript
interface SyncEvent {
  type: "sync"
  phase: "push" | "pull" | "conflict" | "complete" | "error"
  collection?: string           // scoped to collection if applicable
  changes?: number              // number of changes in this phase
  conflicts?: SyncConflict[]    // conflicts that occurred
  error?: Error
  progress?: {
    pushed: number
    pulled: number
    conflicts: number
    failed: number
  }
  timestamp: string
}
```

### 3.4 SyncConflict

```typescript
interface SyncConflict {
  changeId: string              // ID of the local change record
  recordId: ID
  collection: string
  local: Record<string, unknown> | null     // local record snapshot
  remote: Record<string, unknown> | null    // remote record snapshot
  localTimestamp: string
  remoteTimestamp: string
  fieldConflicts?: string[]     // fields that actually differ
  resolution?: "local" | "remote" | "merged"
  resolved?: Record<string, unknown> | null
}
```

---

## 4. Phase 1 — Foundation: Types, Queue, ChangeTracker

### Files to Create

```
src/sync/types.ts         — All sync-related type definitions
src/sync/change-tracker.ts — ChangeTracker class (queue read/write)
src/sync/index.ts          — Barrel export
```

### 4.1 Types (`src/sync/types.ts`)

```typescript
// --- Change Queue ---
export type SyncChangeStatus = "pending" | "syncing" | "committed" | "failed"

export interface SyncChangeRecord {
  id: string
  collection: string
  recordId: ID
  type: "create" | "update" | "delete"
  data: Record<string, unknown> | null
  prevData: Record<string, unknown> | null
  timestamp: string
  status: SyncChangeStatus
  retries: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

// --- Conflict ---
export type ConflictStrategy = "lww" | "client-wins" | "server-wins" | "custom"

export interface SyncConflict {
  changeId: string
  recordId: ID
  collection: string
  local: Record<string, unknown> | null
  remote: Record<string, unknown> | null
  localTimestamp: string
  remoteTimestamp: string
  fieldConflicts: string[]
}

export interface ConflictResolution {
  resolution: "local" | "remote" | "merged"
  merged?: Record<string, unknown> | null
}

export type ConflictResolver = (conflict: SyncConflict) => ConflictResolution | Promise<ConflictResolution>

// --- Transport ---
export interface SyncPushResult {
  accepted: Array<{ id: string; serverTimestamp: string }>
  conflicts: SyncConflict[]
  errors: Array<{ id: string; error: string }>
}

export interface SyncPullResult {
  changes: Array<{
    id: string
    collection: string
    recordId: ID
    type: "create" | "update" | "delete"
    data: Record<string, unknown> | null
    timestamp: string
  }>
  cursor: string | null
  hasMore: boolean
}

export interface PushOptions {
  batchSize?: number
  signal?: AbortSignal
}

export interface PullOptions {
  cursor?: string | null
  collections?: string[]
  batchSize?: number
  signal?: AbortSignal
  timeout?: number
}

export interface SyncTransport {
  readonly name: string
  push(changes: SyncChangeRecord[], options?: PushOptions): Promise<SyncPushResult>
  pull(options?: PullOptions): Promise<SyncPullResult>
  connect?(): Promise<void>
  disconnect?(): Promise<void>
  isConnected?(): boolean
}

// --- Sync Engine ---
export interface SyncConfig {
  transport: SyncTransport
  strategy?: ConflictStrategy
  conflictResolver?: ConflictResolver
  autoSync?: boolean | { intervalMs: number; debounceMs: number; retryMaxDelayMs: number }
  collections?: string[]          // if omitted, all collections sync
  pushBatchSize?: number          // default: 50
  pullBatchSize?: number          // default: 100
  retryMaxAttempts?: number       // default: 10
}

export interface SyncStatus {
  isSyncing: boolean
  isConnected: boolean
  lastSyncAt: string | null
  pendingChanges: number
  failedChanges: number
  lastError: string | null
}

export interface SyncProgress {
  pushed: number
  pulled: number
  conflicts: number
  failed: number
}

// --- Events ---
export type SyncPhase = "push" | "pull" | "conflict" | "complete" | "error"

export interface SyncEvent {
  type: "sync"
  phase: SyncPhase
  collection?: string
  changes?: number
  conflicts?: SyncConflict[]
  error?: Error
  progress?: SyncProgress
  timestamp: string
}

// --- Plugin Config ---
export interface SyncPluginConfig {
  transport: SyncTransport
  strategy?: ConflictStrategy
  conflictResolver?: ConflictResolver
  autoSync?: boolean | { intervalMs?: number; debounceMs?: number }
  collections?: string[]
  pushBatchSize?: number
  pullBatchSize?: number
  retryMaxAttempts?: number
}
```

### 4.2 ChangeTracker (`src/sync/change-tracker.ts`)

```typescript
import type { StorageAdapter, ID } from "../types"
import type { SyncChangeRecord, SyncChangeStatus } from "./types"

export class ChangeTracker {
  readonly storeName = "_ctrodb_sync_changes"

  #adapter: StorageAdapter

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter
  }

  async init(): Promise<void> {
    // Migration check: ensure store exists (it's created via storeNames)
    // Also migrate any changes stuck in "syncing" back to "pending"
    const changes = await this.#adapter.findAll(this.storeName)
    for (const change of changes as SyncChangeRecord[]) {
      if (change.status === "syncing") {
        await this.#adapter.update(this.storeName, change.id, {
          status: "pending",
          retries: change.retries + 1,
          updatedAt: new Date().toISOString(),
        } as Record<string, unknown>)
      }
    }
  }

  async append(
    type: "create" | "update" | "delete",
    collection: string,
    recordId: ID,
    data: Record<string, unknown> | null,
    prevData?: Record<string, unknown> | null,
  ): Promise<string> {
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const now = new Date().toISOString()
    const record: SyncChangeRecord = {
      id,
      collection,
      recordId,
      type,
      data,
      prevData: prevData ?? null,
      timestamp: now,
      status: "pending",
      retries: 0,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.#adapter.create(this.storeName, record as unknown as Record<string, unknown>)
    return id
  }

  async getPending(): Promise<SyncChangeRecord[]> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    return all
      .filter((c) => c.status === "pending" || c.status === "failed")
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  async getById(id: string): Promise<SyncChangeRecord | undefined> {
    const record = await this.#adapter.findById(this.storeName, id)
    return record as SyncChangeRecord | undefined
  }

  async markSyncing(ids: string[]): Promise<void> {
    const now = new Date().toISOString()
    for (const id of ids) {
      await this.#adapter.update(this.storeName, id, {
        status: "syncing",
        updatedAt: now,
      } as Record<string, unknown>)
    }
  }

  async markCommitted(id: string, metadata?: { serverTimestamp?: string }): Promise<void> {
    await this.#adapter.update(this.storeName, id, {
      status: "committed",
      updatedAt: new Date().toISOString(),
      ...(metadata?.serverTimestamp ? { serverTimestamp: metadata.serverTimestamp } : {}),
    } as Record<string, unknown>)
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    const existing = (await this.#adapter.findById(this.storeName, id)) as SyncChangeRecord | undefined
    if (!existing) return
    await this.#adapter.update(this.storeName, id, {
      status: "failed",
      retries: (existing.retries ?? 0) + 1,
      errorMessage,
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>)
  }

  async markPending(id: string): Promise<void> {
    await this.#adapter.update(this.storeName, id, {
      status: "pending",
      updatedAt: new Date().toISOString(),
    } as Record<string, unknown>)
  }

  async countByStatus(status: SyncChangeStatus): Promise<number> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    return all.filter((c) => c.status === status).length
  }

  async countPending(): Promise<number> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    return all.filter((c) => c.status === "pending" || c.status === "failed").length
  }

  async removeCommitted(): Promise<number> {
    const all = (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
    const committed = all.filter((c) => c.status === "committed")
    const ids = committed.map((c) => c.id)
    if (ids.length > 0) {
      await this.#adapter.deleteMany(this.storeName, ids)
    }
    return ids.length
  }

  async getAll(): Promise<SyncChangeRecord[]> {
    return (await this.#adapter.findAll(this.storeName)) as SyncChangeRecord[]
  }

  async getFailed(): Promise<SyncChangeRecord[]> {
    const all = await this.getAll()
    return all.filter((c) => c.status === "failed")
  }
}
```

### 4.3 Key Design Decisions

- **`init()` resets stuck changes**: On startup, any changes in "syncing" status are rolled back to "pending" (with incremented retry). This handles crashes mid-sync.
- **Sorted by timestamp**: Pending changes are always processed in order. This is critical for causality — if record A is created then updated, the create must sync before the update.
- **`removeCommitted()`**: Cleans up successfully synced changes. Called periodically (every N successful syncs) to keep the queue from growing unbounded.
- **UUID generation**: Uses `crypto.randomUUID()` if available, falls back to timestamp+random.

---

## 5. Phase 2 — Conflict Resolver

### File to Create

```
src/sync/conflict-resolver.ts — ConflictResolver class + built-in strategies
```

### 5.1 Implementation

```typescript
import type { SyncConflict, ConflictResolution, ConflictStrategy, ConflictResolver } from "./types"

export class ConflictResolverEngine {
  #strategy: ConflictStrategy
  #customResolver?: ConflictResolver

  constructor(strategy: ConflictStrategy = "lww", customResolver?: ConflictResolver) {
    this.#strategy = strategy
    this.#customResolver = customResolver
  }

  async resolve(conflict: SyncConflict): Promise<ConflictResolution> {
    if (this.#strategy === "custom" && this.#customResolver) {
      return this.#customResolver(conflict)
    }

    switch (this.#strategy) {
      case "client-wins":
        return { resolution: "local" }
      case "server-wins":
        return { resolution: "remote" }
      case "lww":
      default:
        return this.#lww(conflict)
    }
  }

  #lww(conflict: SyncConflict): ConflictResolution {
    const localTs = new Date(conflict.localTimestamp).getTime()
    const remoteTs = new Date(conflict.remoteTimestamp).getTime()

    if (localTs > remoteTs) return { resolution: "local" }
    if (remoteTs > localTs) return { resolution: "remote" }
    // Equal timestamps → server wins (deterministic)
    return { resolution: "remote" }
  }
}
```

### 5.2 Field-Level LWW (Advanced)

```typescript
// Future enhancement: per-field conflict resolution
#fieldLevelLww(conflict: SyncConflict): ConflictResolution {
  if (!conflict.local || !conflict.remote) {
    return { resolution: conflict.local ? "local" : "remote" }
  }

  const merged = { ...conflict.remote }
  const fieldConflicts: string[] = []

  for (const key of Object.keys(merged)) {
    if (key === "id") continue
    const localVal = (conflict.local as Record<string, unknown>)[key]
    const remoteVal = (conflict.remote as Record<string, unknown>)[key]

    if (localVal !== undefined && remoteVal !== undefined && localVal !== remoteVal) {
      fieldConflicts.push(key)
    }
  }

  if (fieldConflicts.length === 0) {
    return { resolution: "remote" }
  }

  // Use #lww but only for conflicting fields
  const winner = this.#lww(conflict)
  if (winner.resolution === "remote") {
    return { resolution: "remote" }
  }

  // Client wins: apply only the local fields that conflict
  for (const key of fieldConflicts) {
    merged[key] = (conflict.local as Record<string, unknown>)[key]
  }
  return { resolution: "merged", merged }
}
```

### 5.3 Conflict Detection

Conflicts are detected in two places:

1. **Server-side** (when pushing): The server compares `updatedAt` of the record against the client's `lastPullCursor` timestamp. If the record was modified on the server after the client's last pull, it's a conflict.

2. **Client-side** (when pulling): After applying remote changes, if a remote change's record has local unsynced changes, it's a conflict. The ConflictResolver is invoked.

### 5.4 Conflict Event Emission

When a conflict occurs, a `SyncEvent` with `phase: "conflict"` is emitted. The app can listen and react:

```typescript
db.on("sync", (event) => {
  if (event.phase === "conflict") {
    console.log("Conflicts:", event.conflicts)
    // Optionally trigger a UI for manual resolution
  }
})

// Or specific conflict handler:
db.onSyncConflict((conflict) => {
  // Return a resolution dynamically
  return { resolution: "local" }
})
```

---

## 6. Phase 3 — Sync Orchestrator

### File to Create

```
src/sync/sync-engine.ts — SyncEngine class
```

### 6.1 Full Implementation

```typescript
import type { StorageAdapter, Database } from "../types"
import { ChangeTracker } from "./change-tracker"
import { ConflictResolverEngine } from "./conflict-resolver"
import type {
  SyncConfig,
  SyncStatus,
  SyncEvent,
  SyncProgress,
  SyncTransport,
  SyncChangeRecord,
  SyncPluginConfig,
} from "./types"

export class SyncEngine {
  #tracker: ChangeTracker
  #resolver: ConflictResolverEngine
  #transport: SyncTransport
  #config: Required<SyncConfig>
  #db: Database

  #isSyncing = false
  #isConnected = false
  #lastSyncAt: string | null = null
  #lastError: string | null = null
  #lastPullCursor: string | null = null

  #autoSyncTimer: ReturnType<typeof setInterval> | null = null
  #autoSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null
  #backoffTimer: ReturnType<typeof setTimeout> | null = null
  #backoffDelay = 1000
  #abortController: AbortController | null = null

  // Event callbacks
  #eventCallbacks: Set<(event: SyncEvent) => void> = new Set()

  constructor(db: Database, config: SyncPluginConfig) {
    this.#db = db
    this.#transport = config.transport
    this.#tracker = new ChangeTracker(db._getAdapter())
    this.#resolver = new ConflictResolverEngine(config.strategy, config.conflictResolver)
    this.#config = {
      transport: config.transport,
      strategy: config.strategy ?? "lww",
      conflictResolver: config.conflictResolver,
      autoSync: config.autoSync ?? false,
      collections: config.collections ?? [],
      pushBatchSize: config.pushBatchSize ?? 50,
      pullBatchSize: config.pullBatchSize ?? 100,
      retryMaxAttempts: config.retryMaxAttempts ?? 10,
    }
  }

  get status(): SyncStatus {
    return {
      isSyncing: this.#isSyncing,
      isConnected: this.#isConnected,
      lastSyncAt: this.#lastSyncAt,
      pendingChanges: 0, // computed lazily; caller can call getPendingCount()
      failedChanges: 0,
      lastError: this.#lastError,
    }
  }

  async getPendingCount(): Promise<number> {
    return this.#tracker.countPending()
  }

  async getFailedCount(): Promise<number> {
    return this.#tracker.countByStatus("failed")
  }

  async init(): Promise<void> {
    await this.#tracker.init()

    // Read persisted state
    const adapter = this.#db._getAdapter()
    this.#lastPullCursor = (await adapter.getMetadata("sync:lastPullCursor")) as string | null
    this.#lastSyncAt = (await adapter.getMetadata("sync:lastSyncAt")) as string | null

    // Connect transport if it supports it
    if (this.#transport.connect) {
      try {
        await this.#transport.connect()
        this.#isConnected = this.#transport.isConnected?.() ?? true
      } catch {
        this.#isConnected = false
      }
    } else {
      this.#isConnected = true
    }

    // Start auto-sync if enabled
    const autoSync = this.#config.autoSync
    if (autoSync) {
      const intervalMs = typeof autoSync === "object" ? autoSync.intervalMs ?? 30000 : 30000
      this.#startAutoSync(intervalMs)
    }
  }

  async destroy(): Promise<void> {
    this.#stopAutoSync()
    this.#cancelBackoff()
    if (this.#transport.disconnect) {
      await this.#transport.disconnect()
    }
    this.#isConnected = false
  }

  // ── Main sync cycle ──

  async sync(): Promise<void> {
    if (this.#isSyncing) return
    this.#isSyncing = true
    this.#abortController = new AbortController()

    try {
      this.#emit({ phase: "push", changes: 0 })

      // Phase 1: Push local changes
      const pushResult = await this.#pushChanges()
      this.#emit({
        phase: "push",
        changes: pushResult.pushed,
        progress: pushResult,
      })

      // Phase 2: Handle conflicts
      if (pushResult.conflicts.length > 0) {
        await this.#resolveConflicts(pushResult.conflicts)
      }

      // Phase 3: Pull remote changes
      const pullResult = await this.#pullChanges()
      this.#emit({
        phase: "pull",
        changes: pullResult.pulled,
        progress: { ...pushResult, ...pullResult },
      })

      // Phase 4: Complete
      this.#lastSyncAt = new Date().toISOString()
      this.#lastError = null
      this.#backoffDelay = 1000 // reset backoff on success

      // Persist state
      const adapter = this.#db._getAdapter()
      await adapter.setMetadata("sync:lastSyncAt", this.#lastSyncAt)
      if (this.#lastPullCursor) {
        await adapter.setMetadata("sync:lastPullCursor", this.#lastPullCursor)
      }

      // Clean up committed changes if we're over threshold
      await this.#tracker.removeCommitted()

      this.#emit({
        phase: "complete",
        changes: pushResult.pushed + pullResult.pulled,
        progress: { ...pushResult, ...pullResult, conflicts: pushResult.conflicts.length },
      })

    } catch (error) {
      this.#lastError = (error as Error).message
      this.#emit({
        phase: "error",
        error: error as Error,
        timestamp: new Date().toISOString(),
      })

      // Schedule retry with backoff
      if (this.#config.autoSync) {
        this.#scheduleBackoff()
      }
    } finally {
      this.#isSyncing = false
      this.#abortController = null
    }
  }

  // ── Push ──

  async #pushChanges(): Promise<SyncProgress> {
    const pending = await this.#tracker.getPending()
    if (pending.length === 0) {
      return { pushed: 0, pulled: 0, conflicts: 0, failed: 0 }
    }

    const batch = pending.slice(0, this.#config.pushBatchSize)
    const batchIds = batch.map((c) => c.id)

    // Mark as syncing (atomic: prevent double-sync)
    await this.#tracker.markSyncing(batchIds)

    try {
      const result = await this.#transport.push(batch, {
        signal: this.#abortController?.signal,
      })

      // Handle accepted
      for (const accepted of result.accepted) {
        await this.#tracker.markCommitted(accepted.id, {
          serverTimestamp: accepted.serverTimestamp,
        })
      }

      // Handle errors
      for (const err of result.errors) {
        await this.#tracker.markFailed(err.id, err.error)
      }

      return {
        pushed: result.accepted.length,
        pulled: 0,
        conflicts: result.conflicts.length,
        failed: result.errors.length,
      }
    } catch (error) {
      // On network error, revert all to pending for retry
      for (const id of batchIds) {
        await this.#tracker.markPending(id)
      }
      throw error
    }
  }

  // ── Pull ──

  async #pullChanges(): Promise<{ pulled: number }> {
    let pulled = 0
    let hasMore = true
    let cursor = this.#lastPullCursor

    while (hasMore) {
      const result = await this.#transport.pull({
        cursor,
        collections: this.#config.collections.length > 0
          ? this.#config.collections
          : undefined,
        batchSize: this.#config.pullBatchSize,
        signal: this.#abortController?.signal,
      })

      for (const change of result.changes) {
        await this.#applyRemoteChange(change)
        pulled++
      }

      cursor = result.cursor
      hasMore = result.hasMore && result.changes.length > 0
    }

    this.#lastPullCursor = cursor
    return { pulled }
  }

  // ── Apply remote change ──

  async #applyRemoteChange(change: {
    id: string
    collection: string
    recordId: ID
    type: "create" | "update" | "delete"
    data: Record<string, unknown> | null
    timestamp: string
  }): Promise<void> {
    const adapter = this.#db._getAdapter()
    const local = await adapter.findById(change.collection, change.recordId)

    switch (change.type) {
      case "create": {
        if (local) {
          // Record exists locally — check for conflict
          const hasPendingChanges = await this.#hasPendingChanges(change.collection, change.recordId)
          if (hasPendingChanges) {
            // User has local unsynced changes — conflict
            // For LWW, compare timestamps
            if (change.timestamp > (local as any).updatedAt ?? "") {
              // Remote wins: overwrite local (but preserve sync queue)
              await adapter.update(change.collection, change.recordId, {
                ...change.data,
                _syncRemoteTimestamp: change.timestamp,
              } as Record<string, unknown>)
            }
            // Local wins: skip remote change
          } else {
            // No local changes — safe to overwrite
            await adapter.update(change.collection, change.recordId, {
              ...change.data,
            } as Record<string, unknown>)
          }
        } else {
          // New record from server
          await adapter.create(change.collection, {
            id: change.recordId,
            ...change.data,
          } as Record<string, unknown>)
        }
        break
      }

      case "update": {
        if (!local) {
          // Record doesn't exist locally — this shouldn't happen for updates
          // but handle gracefully: create it
          await adapter.create(change.collection, {
            id: change.recordId,
            ...change.data,
          } as Record<string, unknown>)
        } else {
          const hasPendingChanges = await this.#hasPendingChanges(change.collection, change.recordId)
          if (hasPendingChanges) {
            // Conflict scenario
            if (change.timestamp > ((local as any).updatedAt ?? "")) {
              await adapter.update(change.collection, change.recordId, {
                ...change.data,
              } as Record<string, unknown>)
            }
            // Otherwise local wins, server change is discarded
          } else {
            await adapter.update(change.collection, change.recordId, {
              ...change.data,
            } as Record<string, unknown>)
          }
        }
        break
      }

      case "delete": {
        if (local) {
          await adapter.delete(change.collection, change.recordId)
        }
        break
      }
    }
  }

  // Check if there are pending/unsynced changes for a specific record
  async #hasPendingChanges(collection: string, recordId: ID): Promise<boolean> {
    const pending = await this.#tracker.getPending()
    return pending.some((c) => c.collection === collection && c.recordId === recordId)
  }

  // ── Conflict resolution ──

  async #resolveConflicts(conflicts: any[]): Promise<void> {
    for (const conflict of conflicts) {
      const resolution = await this.#resolver.resolve(conflict)

      switch (resolution.resolution) {
        case "local":
          // Keep local (already in place), mark change as committed
          await this.#tracker.markCommitted(conflict.changeId)
          break
        case "remote":
          // Apply remote version
          await this.#applyRemoteChange({
            id: conflict.changeId,
            collection: conflict.collection,
            recordId: conflict.recordId,
            type: "update",
            data: conflict.remote as Record<string, unknown>,
            timestamp: conflict.remoteTimestamp,
          })
          await this.#tracker.markCommitted(conflict.changeId)
          break
        case "merged":
          // Apply merged version
          if (resolution.merged) {
            await this.#db._getAdapter().update(
              conflict.collection,
              conflict.recordId,
              resolution.merged as Record<string, unknown>,
            )
          }
          await this.#tracker.markCommitted(conflict.changeId)
          break
      }
    }
  }

  // ── Auto-sync ──

  #startAutoSync(intervalMs: number): void {
    this.#autoSyncTimer = setInterval(() => {
      this.sync()
    }, intervalMs)
  }

  #stopAutoSync(): void {
    if (this.#autoSyncTimer) {
      clearInterval(this.#autoSyncTimer)
      this.#autoSyncTimer = null
    }
  }

  triggerSync(): void {
    if (this.#autoSyncDebounceTimer) {
      clearTimeout(this.#autoSyncDebounceTimer)
    }

    const debounceMs = typeof this.#config.autoSync === "object"
      ? this.#config.autoSync.debounceMs ?? 500
      : 500

    this.#autoSyncDebounceTimer = setTimeout(() => {
      this.sync()
    }, debounceMs)
  }

  // ── Backoff ──

  #scheduleBackoff(): void {
    if (this.#backoffTimer) return

    const maxDelay = typeof this.#config.autoSync === "object"
      ? this.#config.autoSync.retryMaxDelayMs ?? 300000
      : 300000

    const delay = Math.min(this.#backoffDelay, maxDelay)
    // Add jitter: ±25%
    const jitter = delay * (0.75 + Math.random() * 0.5)

    this.#backoffTimer = setTimeout(() => {
      this.#backoffTimer = null
      this.#backoffDelay = Math.min(this.#backoffDelay * 2, maxDelay)
      this.sync()
    }, jitter)
  }

  #cancelBackoff(): void {
    if (this.#backoffTimer) {
      clearTimeout(this.#backoffTimer)
      this.#backoffTimer = null
    }
  }

  // ── Events ──

  onEvent(callback: (event: SyncEvent) => void): () => void {
    this.#eventCallbacks.add(callback)
    return () => this.#eventCallbacks.delete(callback)
  }

  #emit(event: Partial<SyncEvent>): void {
    const fullEvent: SyncEvent = {
      type: "sync",
      phase: event.phase ?? "complete",
      timestamp: new Date().toISOString(),
      ...event,
    }
    for (const cb of this.#eventCallbacks) {
      try {
        cb(fullEvent)
      } catch {
        // Don't let subscriber errors crash the sync engine
      }
    }
  }

  // ── Connectivity ──

  setConnected(connected: boolean): void {
    this.#isConnected = connected
    if (connected && this.#config.autoSync) {
      this.sync()
    }
  }
}
```

### 6.2 Sync Engine Design Rationale

| Decision | Rationale |
|---|---|
| **Batch push/pull** | Avoids overwhelming the network or server with thousands of individual requests. Configurable batch sizes. |
| **AbortController** | Allows cancelling an in-flight sync (e.g., on disconnect, page navigation, or manual abort). |
| **Debounced auto-sync** | Rapid local mutations (e.g., typing in a form) are batched into a single sync cycle. Default 500ms debounce. |
| **Exponential backoff with jitter** | Prevents thundering herd on reconnect. Random jitter (±25%) prevents synchronized retries across multiple clients. |
| **Stuck change recovery** | On init, "syncing" changes are reverted to "pending" — handles browser crash or tab close mid-sync. |
| **Committed cleanup** | Prevents unbounded queue growth. Cleanup runs after each successful sync cycle. |

---

## 7. Phase 4 — HTTP Transport

### File to Create

```
src/sync/http-transport.ts — HttpTransport class
```

### 7.1 Implementation

```typescript
import type {
  SyncTransport,
  SyncPushResult,
  SyncPullResult,
  PushOptions,
  PullOptions,
  SyncChangeRecord,
} from "./types"

export interface HttpTransportConfig {
  url: string                           // Base URL (e.g., "https://api.example.com/sync")
  headers?: Record<string, string>     // Additional headers (Auth, etc.)
  fetchOptions?: RequestInit           // Additional fetch options
  pullMethod?: "GET" | "POST"          // Default: POST
}

export class HttpTransport implements SyncTransport {
  readonly name = "http"
  #config: HttpTransportConfig

  constructor(config: HttpTransportConfig) {
    this.#config = config
  }

  async push(
    changes: SyncChangeRecord[],
    options?: PushOptions,
  ): Promise<SyncPushResult> {
    const response = await fetch(`${this.#config.url}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.#config.headers,
      },
      body: JSON.stringify({ changes }),
      signal: options?.signal,
      ...this.#config.fetchOptions,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error")
      throw new Error(`Sync push failed (${response.status}): ${text}`)
    }

    return response.json() as Promise<SyncPushResult>
  }

  async pull(options?: PullOptions): Promise<SyncPullResult> {
    const method = this.#config.pullMethod ?? "POST"
    const url = options?.cursor
      ? `${this.#config.url}/pull?cursor=${encodeURIComponent(options.cursor)}`
      : `${this.#config.url}/pull`

    const body: Record<string, unknown> = {}
    if (options?.collections) body.collections = options.collections
    if (options?.batchSize) body.batchSize = options.batchSize

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...this.#config.headers,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: options?.signal,
      ...this.#config.fetchOptions,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error")
      throw new Error(`Sync pull failed (${response.status}): ${text}`)
    }

    return response.json() as Promise<SyncPullResult>
  }
}
```

### 7.2 Server API Contract

```
POST /sync/push
  Request Body: {
    changes: Array<{
      id: string
      collection: string
      recordId: string | number
      type: "create" | "update" | "delete"
      data: object | null
      timestamp: string (ISO 8601)
    }>
  }
  Response: {
    accepted: Array<{ id: string; serverTimestamp: string }>
    conflicts: Array<{
      changeId: string
      recordId: string | number
      collection: string
      local: object | null
      remote: object | null
      localTimestamp: string
      remoteTimestamp: string
    }>
    errors: Array<{ id: string; error: string }>
  }

POST /sync/pull
  Request Body: {
    cursor?: string         // Omit for initial pull (get all)
    collections?: string[]  // Only pull these collections
    batchSize?: number      // Pagination
  }
  Response: {
    changes: Array<{
      id: string
      collection: string
      recordId: string | number
      type: "create" | "update" | "delete"
      data: object | null
      timestamp: string
    }>
    cursor: string | null   // Next page cursor. null = no more.
    hasMore: boolean
  }
```

### 7.3 Conflict Detection on Server (for push)

The server determines a conflict by comparing the `updatedAt` of the record against the client's knowledge. The logic:

```
For each pushed change:
  1. Find the record in the server database by (collection, recordId)
  2. If the record doesn't exist:
     - Accept the create (or if it's an update, create it as a new record)
  3. If the record exists:
     - Compare record.updatedAt > change.timestamp (the client's last known state)
     - If record.updatedAt > change.timestamp → CONFLICT
     - Else → ACCEPT (apply the change, update updatedAt)
  4. For deletes:
     - If record exists → delete it (no conflict — deletes always win)
     - If not found → accept (idempotent)
```

---

## 8. Phase 5 — Sync Plugin & Database Integration

### Files to Create

```
src/sync/sync-plugin.ts — syncPlugin() factory
```

### 8.1 Plugin Factory

```typescript
import type { Collection } from "../collection"
import type { Database } from "../database"
import type { CtroDBPlugin, ID } from "../types"
import { SyncEngine } from "./sync-engine"
import { ChangeTracker } from "./change-tracker"
import type { SyncPluginConfig } from "./types"

export function syncPlugin(config: SyncPluginConfig): CtroDBPlugin {
  let engine: SyncEngine
  let tracker: ChangeTracker

  return {
    name: "sync",
    version: "1.0.0",
    storeNames: ["_ctrodb_sync_changes"],

    onDatabaseInit(db: Database) {
      tracker = new ChangeTracker(db._getAdapter())
      engine = new SyncEngine(db, config)
    },

    onCollectionInit(_collection: Collection<any>) {
      // If collections filter is set, we register only those
      // For now, tracking happens for all collections
      // The filter is applied at sync time
      // Future: store which collections are synced for schema awareness
    },

    async onAfterCreate(_collection: string, record: unknown) {
      const r = record as Record<string, unknown>
      await tracker.append("create", _collection, r.id as ID, r)
    },

    async onAfterUpdate(_collection: string, _id: ID, record: unknown, oldRecord?: unknown) {
      const r = record as Record<string, unknown>
      const old = oldRecord as Record<string, unknown> | undefined
      await tracker.append("update", _collection, _id, r, old ?? null)
    },

    async onAfterDelete(_collection: string, _id: ID, oldRecord?: unknown) {
      const old = oldRecord as Record<string, unknown> | undefined
      await tracker.append("delete", _collection, _id, null, old ?? null)
    },
  } as CtroDBPlugin
}
```

### 8.2 Hook: `onCollectionInit` and Synced Collections

The sync plugin needs to know which collections to sync. We add a `sync` property to the schema:

```typescript
// In CollectionSchema (src/types.ts):
export interface CollectionSchema {
  fields: Record<string, FieldDefinition>
  indexes?: IndexDefinition[]
  searchable?: string[]
  relations?: Record<string, RelationDefinition>
  sync?: boolean  // NEW: opt-in per collection
}
```

If `sync` is not set on any collection, the plugin checks the `collections` config array. If neither is set, all collections sync (current behavior).

### 8.3 Preventing Sync Loops

When applying remote changes during pull, we must NOT trigger the sync plugin's `onAfterCreate/Update/Delete` hooks (which would re-queue the incoming changes for push).

**Solution**: A `_syncInProgress` flag on the adapter. The sync engine sets this flag before applying remote changes, and the sync plugin's hooks check it and skip tracking.

```typescript
// On the StorageAdapter:
interface StorageAdapter {
  // ...existing...
  _syncInProgress?: boolean  // Not part of the interface; duck-typed
}

// In SyncEngine.#applyRemoteChange():
const adapter = this.#db._getAdapter() as any
adapter._syncInProgress = true
try {
  // ... apply changes ...
} finally {
  adapter._syncInProgress = false
}

// In SyncPlugin.onAfterCreate():
async onAfterCreate(_collection: string, record: unknown) {
  const db = /* get active db */ as any
  if (db._getAdapter()._syncInProgress) return  // Skip sync tracking
  await tracker.append("create", _collection, (record as any).id, record)
}
```

**Alternative**: Pass a `source` flag through the plugin hooks. This is cleaner:

```typescript
// Extend ChangeEvent / plugin hooks with a source parameter
// e.g., { source: "local" | "remote" | "sync" }

// In Collection.create/update/delete:
const event: ChangeEvent = {
  type: "create",
  collection: this.name,
  recordId: record.id,
  record,
  source: "local",  // NEW
}

// Sync plugin hooks check:
onAfterCreate(collection, record) {
  if (record._source === "sync") return  // Skip sync tracking
  // ...
}
```

But this requires modifying core collection.ts which violates our principle of zero changes to core.

**Simplest approach**: The sync engine applies changes directly through `adapter.create/update/delete` (bypassing Collection and its hooks). The Collection class is the one that fires hooks. By going directly to the adapter, we naturally avoid the loop.

```typescript
// In SyncEngine.#applyRemoteChange():
await adapter.create(change.collection, { id: change.recordId, ...change.data })
// This calls adapter.create() directly, NOT collection.create()
// So onAfterCreate hooks are NOT fired.
// No sync loop.
```

This is the cleanest solution — the adapter doesn't fire hooks; only Collection does.

### 8.4 Database Integration (Minimal Changes to `src/database.ts`)

We add three small things to the `Database` class:

```typescript
export class Database {
  // ... existing ...

  // NEW: Sync API
  async sync(): Promise<void> {
    const plugin = this.#plugins.find((p) => p.name === "sync") as any
    if (plugin?._engine) {
      return plugin._engine.sync()
    }
    throw new Error("Sync plugin not registered")
  }

  onSync(callback: (event: SyncEvent) => void): () => void {
    const plugin = this.#plugins.find((p) => p.name === "sync") as any
    if (plugin?._engine) {
      return plugin._engine.onEvent(callback)
    }
    throw new Error("Sync plugin not registered")
  }

  get syncStatus(): SyncStatus {
    const plugin = this.#plugins.find((p) => p.name === "sync") as any
    if (plugin?._engine) {
      return plugin._engine.status
    }
    throw new Error("Sync plugin not registered")
  }
}
```

Wait — this requires the `Database` class to know about the sync plugin specifically. Better approach: **keep sync API on the plugin itself**.

```typescript
const db = new Database({ name: "app", plugins: [syncPlugin({ ... })] })
await db.connect()

// Access sync via the plugin:
const sync = db.plugin("sync")  // NEW: db.plugin(name) returns plugin instance
await sync.sync()
sync.onEvent((event) => { ... })
sync.status

// Or keep it simple with a direct export:
import { getSyncEngine } from "ctrodb/sync"
const engine = getSyncEngine(db)
await engine.sync()
```

**Final decision**: Add `db.plugin(name)` accessor + `db.sync()`, `db.onSync()`, `db.syncStatus` convenience methods to Database. The core changes are minimal (adding 20 lines to database.ts), and the user API is much better.

### 8.5 Updated `src/database.ts` Changes

```typescript
// Add to imports:
import type { SyncEvent, SyncStatus } from "./sync/types"

// Add to class:
  plugin(name: string): CtroDBPlugin | undefined {
    return this.#plugins.find((p) => p.name === name)
  }

  async sync(): Promise<void> {
    const plugin = this.plugin("sync") as any
    if (plugin?._engine?.sync) {
      return plugin._engine.sync()
    }
    throw new Error("Sync plugin not registered or not initialized")
  }

  onSync(callback: (event: SyncEvent) => void): () => void {
    const plugin = this.plugin("sync") as any
    if (plugin?._engine?.onEvent) {
      return plugin._engine.onEvent(callback)
    }
    throw new Error("Sync plugin not registered or not initialized")
  }

  get syncStatus(): SyncStatus {
    const plugin = this.plugin("sync") as any
    if (plugin?._engine?.status) {
      return plugin._engine.status
    }
    throw new Error("Sync plugin not registered or not initialized")
  }
```

### 8.6 Updated `syncPlugin()` with Engine Attachment

```typescript
import { SyncEngine } from "./sync-engine"

export function syncPlugin(config: SyncPluginConfig): CtroDBPlugin & { _engine?: SyncEngine } {
  let engine: SyncEngine
  let tracker: ChangeTracker
  let db: Database

  const plugin: CtroDBPlugin & { _engine?: SyncEngine } = {
    name: "sync",
    version: "1.0.0",
    storeNames: ["_ctrodb_sync_changes"],

    onDatabaseInit(_db: Database) {
      db = _db
      tracker = new ChangeTracker(_db._getAdapter())
      engine = new SyncEngine(_db, config)
      plugin._engine = engine  // Attach for Database.sync() to access
    },

    // ... hooks ...
  }

  return plugin
}
```

### 8.7 Main Entry Point (`src/index.ts`) Changes

```typescript
// Add exports:
export { syncPlugin } from "./sync/sync-plugin"
export type { SyncEvent, SyncStatus, SyncConfig, SyncConflict, SyncTransport } from "./sync/types"
export { HttpTransport } from "./sync/http-transport"
// also re-export SyncEngine? Probably not — users interact through db.sync()
```

### 8.8 Build Configuration (`tsup.config.ts`) Changes

Sync is bundled into the main entry (not a separate sub-entry like react). No changes needed to tsup config — it's part of `src/index.ts`.

### 8.9 Updated Plugin Export (`src/plugins/index.ts`) Changes

Do NOT export from `src/plugins/index.ts` — sync is at the top level like the core, not a plugin sub-module. It's exported directly from `src/index.ts`.

### 8.10 Type Changes (`src/types.ts`)

Add `sync?: boolean` to `CollectionSchema`:

```typescript
export interface CollectionSchema {
  fields: Record<string, FieldDefinition>
  indexes?: IndexDefinition[]
  searchable?: string[]
  relations?: Record<string, RelationDefinition>
  sync?: boolean  // NEW: opt-in to sync
}
```

### 8.11 Effect on Schema Version

Adding `sync` field to `CollectionSchema` is purely a TypeScript type addition. It doesn't change the IndexedDB schema version because `CollectionSchema` is not serialized to the adapter's schema — only `fields` and `indexes` are used for object store creation in `createMigrationHandler`.

---

## 9. Phase 6 — React Hooks

### File to Modify

```
src/react.ts — Add useSyncStatus(), useSyncQueue()
```

### 9.1 Hooks

```typescript
// In src/react.ts

export interface SyncStatusResult {
  isSyncing: boolean
  isConnected: boolean
  lastSyncAt: string | null
  pendingChanges: number
  failedChanges: number
  lastError: string | null
}

export function useSyncStatus(): SyncStatusResult {
  const db = useDatabase()
  const [status, setStatus] = useState<SyncStatusResult>({
    isSyncing: false,
    isConnected: false,
    lastSyncAt: null,
    pendingChanges: 0,
    failedChanges: 0,
    lastError: null,
  })

  useEffect(() => {
    let cancelled = false

    async function update() {
      try {
        const s = db.syncStatus
        if (!cancelled) {
          setStatus({
            ...s,
            pendingChanges: await s.pendingChanges,
            failedChanges: await s.failedChanges,
          })
        }
      } catch {
        // Sync plugin not registered
      }
    }

    update()

    let unsub: (() => void) | undefined
    try {
      unsub = db.onSync((_event) => {
        update()
      })
    } catch {
      // Sync plugin not registered
    }

    // Refresh status every 5 seconds even without events
    const interval = setInterval(update, 5000)

    return () => {
      cancelled = true
      unsub?.()
      clearInterval(interval)
    }
  }, [db])

  return status
}

export function useSync(callback?: (event: SyncEvent) => void): {
  sync: () => Promise<void>
  status: SyncStatusResult
} {
  const db = useDatabase()
  const status = useSyncStatus()

  const sync = useCallback(async () => {
    await db.sync()
  }, [db])

  useEffect(() => {
    if (!callback) return
    let unsub: (() => void) | undefined
    try {
      unsub = db.onSync(callback)
    } catch {
      // Sync plugin not registered
    }
    return () => unsub?.()
  }, [db, callback])

  return { sync, status }
}
```

### 9.2 Usage Examples

```tsx
function SyncIndicator() {
  const { isSyncing, pendingChanges, lastError, lastSyncAt, isConnected } = useSyncStatus()

  if (!isConnected) return <div className="badge-warning">Offline</div>
  if (isSyncing) return <div className="badge-info">Syncing...</div>
  if (lastError) return <div className="badge-error">Sync error: {lastError}</div>
  if (pendingChanges > 0) return <div className="badge-pending">{pendingChanges} unsaved</div>

  return <div className="badge-ok">All synced</div>
}

function ManualSyncButton() {
  const { sync, status } = useSync()
  return (
    <button onClick={sync} disabled={status.isSyncing}>
      {status.isSyncing ? "Syncing..." : "Sync Now"}
    </button>
  )
}
```

---

## 10. Phase 7 — WebSocket Transport

### File to Create

```
src/sync/ws-transport.ts — WsTransport class
```

### 10.1 Implementation

```typescript
import type {
  SyncTransport,
  SyncPushResult,
  SyncPullResult,
  PushOptions,
  PullOptions,
  SyncChangeRecord,
} from "./types"

export interface WsTransportConfig {
  url: string                           // WebSocket URL (e.g., "wss://api.example.com/sync")
  headers?: Record<string, string>     // Auth headers (sent in initial connect message)
  reconnectInterval?: number           // Default: 3000
  maxReconnectAttempts?: number        // Default: 10
}

interface WsMessage {
  type: "push" | "pull" | "push_result" | "pull_result" | "server_push" | "error" | "auth"
  requestId?: string
  payload?: unknown
}

export class WsTransport implements SyncTransport {
  readonly name = "websocket"
  #config: Required<WsTransportConfig>
  #ws: WebSocket | null = null
  #connected = false
  #pendingRequests = new Map<string, {
    resolve: (value: any) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  #requestCounter = 0
  #reconnectAttempts = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #onServerPush: ((changes: any[]) => void) | null = null
  #shouldReconnect = true

  constructor(config: WsTransportConfig) {
    this.#config = {
      url: config.url,
      headers: config.headers ?? {},
      reconnectInterval: config.reconnectInterval ?? 3000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    }
  }

  async connect(): Promise<void> {
    this.#shouldReconnect = true
    return this.#connect()
  }

  #connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.#ws = new WebSocket(this.#config.url)

        this.#ws.onopen = () => {
          this.#connected = true
          this.#reconnectAttempts = 0

          // Send auth if headers provided
          if (Object.keys(this.#config.headers).length > 0) {
            this.#send({ type: "auth", payload: this.#config.headers })
          }

          resolve()
        }

        this.#ws.onmessage = (event) => {
          try {
            const msg: WsMessage = JSON.parse(event.data)
            this.#handleMessage(msg)
          } catch {
            // Ignore malformed messages
          }
        }

        this.#ws.onclose = () => {
          this.#connected = false
          this.#rejectAllPending(new Error("WebSocket disconnected"))
          if (this.#shouldReconnect) {
            this.#scheduleReconnect()
          }
        }

        this.#ws.onerror = () => {
          // onclose will fire after this
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  async disconnect(): Promise<void> {
    this.#shouldReconnect = false
    this.#cancelReconnect()
    this.#ws?.close()
    this.#ws = null
    this.#connected = false
  }

  isConnected(): boolean {
    return this.#connected
  }

  // ── Push ──

  async push(changes: SyncChangeRecord[], options?: PushOptions): Promise<SyncPushResult> {
    const requestId = this.#nextRequestId()
    const result = this.#waitForResponse<SyncPushResult>(requestId, options?.signal)

    this.#send({
      type: "push",
      requestId,
      payload: { changes },
    })

    return result
  }

  // ── Pull ──

  async pull(options?: PullOptions): Promise<SyncPullResult> {
    const requestId = this.#nextRequestId()
    const result = this.#waitForResponse<SyncPullResult>(requestId, options?.signal)

    this.#send({
      type: "pull",
      requestId,
      payload: {
        cursor: options?.cursor,
        collections: options?.collections,
        batchSize: options?.batchSize,
      },
    })

    return result
  }

  // ── Server push handler ──

  onServerPush(callback: (changes: any[]) => void): () => void {
    this.#onServerPush = callback
    return () => { this.#onServerPush = null }
  }

  // ── Internal ──

  #send(msg: WsMessage): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected")
    }
    this.#ws.send(JSON.stringify(msg))
  }

  #handleMessage(msg: WsMessage): void {
    if (msg.type === "server_push") {
      this.#onServerPush?.(msg.payload as any[])
      return
    }

    if (msg.requestId) {
      const pending = this.#pendingRequests.get(msg.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.#pendingRequests.delete(msg.requestId)

        if (msg.type === "error") {
          pending.reject(new Error((msg.payload as any)?.message ?? "Unknown error"))
        } else {
          pending.resolve(msg.payload)
        }
      }
    }
  }

  #waitForResponse<T>(requestId: string, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = 30000 // 30s default timeout
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(requestId)
        reject(new Error("Request timed out"))
      }, timeout)

      this.#pendingRequests.set(requestId, { resolve, reject, timer })

      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          this.#pendingRequests.delete(requestId)
          reject(new DOMException("Aborted", "AbortError"))
        }, { once: true })
      }
    })
  }

  #nextRequestId(): string {
    return `req_${++this.#requestCounter}_${Date.now()}`
  }

  #rejectAllPending(error: Error): void {
    for (const [id, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pendingRequests.clear()
  }

  #scheduleReconnect(): void {
    if (this.#reconnectAttempts >= this.#config.maxReconnectAttempts) return

    this.#reconnectAttempts++
    const delay = this.#config.reconnectInterval * Math.pow(1.5, this.#reconnectAttempts - 1)

    this.#reconnectTimer = setTimeout(() => {
      this.#connect().catch(() => {
        // Reconnect failures are handled by onclose
      })
    }, delay)
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }
}
```

### 10.2 WebSocket Server Protocol

The WebSocket transport uses a request-response pattern over WebSocket:

```
Client → Server:
  { type: "push", requestId: "req_1", payload: { changes: [...] } }
  { type: "pull", requestId: "req_2", payload: { cursor: "...", collections: [...], batchSize: 100 } }
  { type: "auth", payload: { Authorization: "Bearer token" } }

Server → Client:
  { type: "push_result", requestId: "req_1", payload: { accepted: [...], conflicts: [...], errors: [...] } }
  { type: "pull_result", requestId: "req_2", payload: { changes: [...], cursor: "...", hasMore: false } }
  { type: "server_push", requestId: null, payload: [{ collection: "todos", recordId: "abc", type: "update", data: {...}, timestamp: "..." }] }
  { type: "error", requestId: "req_1", payload: { message: "Invalid changes" } }
```

### 10.3 When to Use HTTP vs WebSocket

| Scenario | HTTP | WebSocket |
|---|---|---|
| Periodic sync (every 30s) | ✅ Efficient | ❌ Overkill |
| Real-time collaboration | ❌ Polling delay | ✅ Instant push |
| Serverless (Vercel, Netlify) | ✅ Works well | ❌ No persistent WS |
| Offline-first mobile | ✅ Simple fetch | ❌ Connection overhead |
| High-frequency updates | ❌ Request overhead | ✅ Single connection |
| Firewall-restricted env | ✅ HTTP/2 works | ❌ WS may be blocked |

**Recommendation**: Default to HTTP. Offer WebSocket for real-time use cases.

---

## 11. Phase 8 — Multi-Tab & Background Sync

### 11.1 Multi-Tab Problem

When two browser tabs use the same IndexedDB database, changes made in Tab A are immediately visible in Tab B's IndexedDB, but Tab B's signal system has no way of knowing about them. This means:

- Tab B's `useQuery()` won't re-render
- Tab B's sync queue won't know about Tab A's changes
- Tab A and Tab B will both try to sync the same changes

### 11.2 Solution: BroadcastChannel

Use the **BroadcastChannel API** to notify other tabs of local changes:

```typescript
// In ChangeTracker, after appending a change:
const channel = new BroadcastChannel("ctrodb:sync")
channel.postMessage({
  type: "change",
  collection: "todos",
  recordId: "abc-123",
  changeType: "create",
})
channel.close()
```

```typescript
// In SyncEngine.init(), subscribe to broadcast messages:
const channel = new BroadcastChannel("ctrodb:sync")
channel.onmessage = (event) => {
  if (event.data?.type === "change") {
    // Force re-evaluate sync status
    this.#emit({ phase: "push" })
    // Also notify the signal system to re-render UI
    // by emitting a local ChangeEvent
    this.#db._emit({
      type: event.data.changeType,
      collection: event.data.collection,
      recordId: event.data.recordId,
      source: "broadcast",
    })
  }
}
```

### 11.3 Background Sync (Web API)

For progressive web apps (PWAs), use the **Background Sync API** to sync when the device comes back online:

```typescript
// Register sync when going offline:
if ("serviceWorker" in navigator && "SyncManager" in window) {
  navigator.serviceWorker.ready.then((registration) => {
    registration.sync.register("ctrodb-sync")
  })
}

// In the service worker:
self.addEventListener("sync", (event) => {
  if (event.tag === "ctrodb-sync") {
    event.waitUntil(
      // The ServiceWorker doesn't have direct access to IndexedDB in the same way,
      // so we use a client message:
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: "ctrodb-background-sync" })
        })
      })
    )
  }
})
```

### 11.4 Online/Offline Detection

```typescript
// In SyncEngine.init():
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    this.setConnected(true)
  })
  window.addEventListener("offline", () => {
    this.setConnected(false)
  })
}
```

---

## 12. Phase 9 — Inspection, Debugging & Developer Tools

### 12.1 Sync Queue Inspector

```typescript
// Utility function for dev tools
export async function inspectSyncQueue(db: Database): Promise<{
  pending: SyncChangeRecord[]
  syncing: SyncChangeRecord[]
  committed: SyncChangeRecord[]
  failed: SyncChangeRecord[]
  stats: {
    total: number
    pending: number
    syncing: number
    committed: number
    failed: number
  }
}> {
  const engine = (db.plugin?.("sync") as any)?._engine as SyncEngine | undefined
  if (!engine) throw new Error("Sync plugin not registered")

  const tracker = new ChangeTracker(db._getAdapter())
  const all = await tracker.getAll()

  const stats = {
    total: all.length,
    pending: all.filter((c) => c.status === "pending").length,
    syncing: all.filter((c) => c.status === "syncing").length,
    committed: all.filter((c) => c.status === "committed").length,
    failed: all.filter((c) => c.status === "failed").length,
  }

  return {
    pending: all.filter((c) => c.status === "pending"),
    syncing: all.filter((c) => c.status === "syncing"),
    committed: all.filter((c) => c.status === "committed"),
    failed: all.filter((c) => c.status === "failed"),
    stats,
  }
}

// For manual retry of failed changes
export async function retryFailedSync(db: Database): Promise<number> {
  const engine = (db.plugin?.("sync") as any)?._engine as SyncEngine | undefined
  if (!engine) throw new Error("Sync plugin not registered")

  const tracker = new ChangeTracker(db._getAdapter())
  const failed = await tracker.getFailed()
  for (const change of failed) {
    await tracker.markPending(change.id)
  }
  await engine.sync()
  return failed.length
}

// For clearing committed changes
export async function clearCommittedSync(db: Database): Promise<number> {
  const tracker = new ChangeTracker(db._getAdapter())
  return tracker.removeCommitted()
}
```

### 12.2 React Developer Tools Integration

```tsx
function SyncDevPanel() {
  const db = useDatabase()
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    inspectSyncQueue(db).then(setData)
  }, [db])

  if (!data) return <div>Loading...</div>

  return (
    <div style={{ fontFamily: "monospace", fontSize: 12 }}>
      <h3>Sync Queue ({data.stats.total})</h3>
      <ul>
        <li>Pending: {data.stats.pending}</li>
        <li>Syncing: {data.stats.syncing}</li>
        <li>Committed: {data.stats.committed}</li>
        <li>Failed: {data.stats.failed}</li>
      </ul>
      {data.failed.length > 0 && (
        <div>
          <h4>Failed Changes</h4>
          {data.failed.map((c: any) => (
            <div key={c.id}>
              {c.collection}.{c.recordId} — {c.errorMessage}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

---

## 13. Phase 10 — Server SDK & Example Backends

### 13.1 Files to Create

```
examples/sync/
├── server-node/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts        — Express/Fastify server
│       ├── routes/
│       │   ├── push.ts     — POST /sync/push
│       │   ├── pull.ts     — POST /sync/pull
│       │   └── ws.ts       — WebSocket handler
│       └── store.ts        — In-memory/DB store
├── server-supabase/
│   └── README.md           — How to use Supabase as backend
└── README.md               — Server implementation guide
```

### 13.2 Node.js Reference Server

```typescript
// Minimal Express server implementing the sync contract
import express from "express"

interface Store {
  records: Map<string, Map<string, any>>  // collection -> id -> record
  changes: any[]                          // ordered change log
}

const store: Store = {
  records: new Map(),
  changes: [],
}

const app = express()
app.use(express.json())

// ── Push ──
app.post("/sync/push", (req, res) => {
  const { changes } = req.body
  const accepted: any[] = []
  const conflicts: any[] = []
  const errors: any[] = []

  for (const change of changes) {
    try {
      const col = store.records.get(change.collection) ?? new Map()
      store.records.set(change.collection, col)
      const existing = col.get(change.recordId)

      if (change.type === "create" && existing) {
        // Conflict! Record already exists
        conflicts.push({
          changeId: change.id,
          recordId: change.recordId,
          collection: change.collection,
          local: change.data,
          remote: existing,
          localTimestamp: change.timestamp,
          remoteTimestamp: existing.updatedAt,
        })
        continue
      }

      if ((change.type === "update" || change.type === "delete") && existing) {
        if (existing.updatedAt > change.timestamp) {
          // Conflict — remote was modified after client's last sync
          conflicts.push({
            changeId: change.id,
            recordId: change.recordId,
            collection: change.collection,
            local: change.data,
            remote: existing,
            localTimestamp: change.timestamp,
            remoteTimestamp: existing.updatedAt,
          })
          continue
        }
      }

      // Accept the change
      const serverTimestamp = new Date().toISOString()
      const record = { ...change.data, updatedAt: serverTimestamp }

      if (change.type === "delete") {
        col.delete(change.recordId)
      } else {
        col.set(change.recordId, record)
      }

      // Append to change log for pull
      store.changes.push({
        id: `svr_${store.changes.length + 1}`,
        collection: change.collection,
        recordId: change.recordId,
        type: change.type,
        data: change.type === "delete" ? null : record,
        timestamp: serverTimestamp,
      })

      accepted.push({ id: change.id, serverTimestamp })

    } catch (error: any) {
      errors.push({ id: change.id, error: error.message })
    }
  }

  res.json({ accepted, conflicts, errors })
})

// ── Pull ──
app.post("/sync/pull", (req, res) => {
  const { cursor, collections, batchSize = 100 } = req.body

  const cursorIndex = cursor
    ? store.changes.findIndex((c) => c.id === cursor)
    : -1

  const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0
  const changes = store.changes.slice(startIndex, startIndex + batchSize)

  // Filter by collection if specified
  const filtered = collections
    ? changes.filter((c) => collections.includes(c.collection))
    : changes

  const nextCursor = filtered.length > 0
    ? filtered[filtered.length - 1].id
    : cursor

  res.json({
    changes: filtered,
    cursor: nextCursor,
    hasMore: startIndex + batchSize < store.changes.length,
  })
})

app.listen(3000, () => console.log("Sync server on :3000"))
```

### 13.3 Supabase Integration Guide

```typescript
// Supabase transport
import { createClient } from "@supabase/supabase-js"

class SupabaseTransport implements SyncTransport {
  readonly name = "supabase"
  #supabase: ReturnType<typeof createClient>

  constructor(url: string, anonKey: string) {
    this.#supabase = createClient(url, anonKey)
  }

  async push(changes: SyncChangeRecord[]): Promise<SyncPushResult> {
    const results: SyncPushResult = { accepted: [], conflicts: [], errors: [] }

    for (const change of changes) {
      try {
        const { data, error } = await this.#supabase
          .from(change.collection)
          .upsert({
            id: change.recordId,
            ...change.data,
            updated_at: change.timestamp,
          })
          .select()

        if (error) {
          results.errors.push({ id: change.id, error: error.message })
        } else {
          results.accepted.push({
            id: change.id,
            serverTimestamp: new Date().toISOString(),
          })
        }
      } catch (err: any) {
        results.errors.push({ id: change.id, error: err.message })
      }
    }

    return results
  }

  async pull(options?: PullOptions): Promise<SyncPullResult> {
    let query = this.#supabase
      .from("_sync_log")
      .select("*")
      .order("id", { ascending: true })
      .limit(options?.batchSize ?? 100)

    if (options?.cursor) {
      query = query.gt("id", options.cursor)
    }

    const { data, error } = await query

    if (error) throw new Error(error.message)

    const changes = (data ?? []).map((row: any) => ({
      id: row.id,
      collection: row.collection,
      recordId: row.record_id,
      type: row.change_type,
      data: row.data,
      timestamp: row.created_at,
    }))

    return {
      changes,
      cursor: changes.length > 0 ? changes[changes.length - 1].id : null,
      hasMore: (data?.length ?? 0) >= (options?.batchSize ?? 100),
    }
  }
}
```

---

## 14. Testing Strategy

### 14.1 Unit Tests

| Test | File | What it covers |
|---|---|---|
| ChangeTracker.append() creates record | `tests/unit/sync/change-tracker.test.ts` | Queue write |
| ChangeTracker.getPending() returns ordered | Same | Queue read + ordering |
| ChangeTracker states: pending→syncing→committed/failed | Same | State machine transitions |
| ChangeTracker.init() resets stuck "syncing" | Same | Crash recovery |
| ConflictResolver.LWW: local wins | `tests/unit/sync/conflict-resolver.test.ts` | LWW local > remote |
| ConflictResolver.LWW: remote wins | Same | LWW remote > local |
| ConflictResolver.LWW: tie → server wins | Same | Deterministic tiebreak |
| ConflictResolver.client-wins | Same | Client always wins |
| ConflictResolver.server-wins | Same | Server always wins |
| ConflictResolver.custom resolver | Same | User-defined resolver |
| HttpTransport.push() | `tests/unit/sync/http-transport.test.ts` | Network push |
| HttpTransport.pull() | Same | Network pull |
| HttpTransport error handling | Same | Non-200 responses |
| WsTransport.connect/disconnect | `tests/unit/sync/ws-transport.test.ts` | Lifecycle |
| WsTransport.push/pull roundtrip | Same | Request-response over WS |
| WsTransport.server push | Same | Real-time push handler |
| WsTransport.reconnect | Same | Auto-reconnect |
| WsTransport.timeout | Same | Pending request timeout |

### 14.2 Integration Tests

| Test | What it covers |
|---|---|
| Sync cycle: create → track → push → commit | `tests/integration/sync-flow.test.ts` |
| Sync cycle: update → track → push → commit | Same |
| Sync cycle: delete → track → push → commit | Same |
| Pull: server changes → apply locally | Same |
| Pull: pagination (hasMore) | Same |
| Push: partial failure (some accepted, some errors) | Same |
| Conflict: auto-resolve with LWW | Same |
| Conflict: auto-resolve with client-wins | Same |
| Auto-sync: changes pushed on timer | Same |
| Auto-sync: debounce rapid changes | Same |
| Offline: changes queue until reconnect | Same |
| Backoff: retry delay increases | Same |
| Multi-collection sync | Same |

### 14.3 End-to-End Tests

| Test | What it covers |
|---|---|
| Two clients sync via HTTP server | `tests/e2e/sync-two-clients.test.ts` |
| Conflict scenario: offline edit, then sync | Same |
| Real-time sync via WebSocket | Same |
| Full roundtrip with server push | Same |

### 14.4 Test Mocks

```typescript
// Mock transport for unit/integration tests
class MockTransport implements SyncTransport {
  readonly name = "mock"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }
  connected = true

  async push(): Promise<SyncPushResult> { return this.pushResult }
  async pull(): Promise<SyncPullResult> { return this.pullResult }
  connect(): Promise<void> { return Promise.resolve() }
  disconnect(): Promise<void> { return Promise.resolve() }
  isConnected(): boolean { return this.connected }
}
```

### 14.5 Incremental Test Strategy

1. Write all unit tests first (no network, pure logic)
2. Write integration tests with MockTransport (core sync flow)
3. Write integration tests with a local test server (full HTTP roundtrip)
4. Write e2e tests (two browser contexts via playwright/puppeteer)

---

## 15. Edge Cases & Error Handling

### 15.1 Edge Cases

| Edge Case | Handling |
|---|---|
| **Mutation during sync** | The sync cycle uses a snapshot of pending changes. Mutations during sync are appended to the queue and picked up in the next cycle. |
| **Same record mutated multiple times before sync** | Only the latest snapshot is pushed (the queue tracks each mutation separately, but the last update/delete for a record determines the final state). |
| **Create then delete before sync** | Both changes are in the queue. On push, the server receives a create then a delete. The server applies both (create, then delete). The local queue marks both committed. |
| **Update then delete before sync** | Similar — both changes are pushed. Server applies update, then delete. Net effect: record is deleted. |
| **Tab crash mid-sync** | 'syncing' changes are reverted to 'pending' on next init(). Unapplied remote changes are re-pulled. |
| **Server returns conflict for a create** | Rare edge case where remote already has the same ID. The ConflictResolver determines which version wins. Mitigation: use UUIDs. |
| **Queue grows unbounded** | After each successful sync, `removeCommitted()` cleans up. Configurable threshold. |
| **Network timeout during push** | Changes stay in 'syncing' → reverted to 'pending' on init or next sync. Backoff applies. |
| **Clock skew** | Server timestamps are authoritative. Client timestamps are used only for local ordering and conflict comparison relative to last pull cursor. |
| **Concurrent sync calls** | `#isSyncing` flag prevents concurrent sync cycles. |
| **Adapter in transaction** | The sync engine should NOT use `adapter.transaction()` because it holds the transaction open too long. Instead, it uses individual `adapter.create/update/delete` calls. |
| **Record schema changes during sync** | The sync engine is schema-agnostic. It sends raw `data` objects. Schema validation happens on the server or during local `collection.create()`, not during sync engine's direct adapter calls. |

### 15.2 Error Categories

| Error Type | Recovery Strategy |
|---|---|
| **Network error** | Exponential backoff + retry |
| **Server error (4xx/5xx)** | Backoff + retry (with jitter) |
| **Validation error (per-change)** | Mark individual change as 'failed', continue batch |
| **Timeout** | Abort batch, revert to pending, backoff + retry |
| **Auth error (401)** | Stop syncing, emit error event, user must re-authenticate |
| **Rate limit (429)** | Backoff + retry with longer delay |

---

## 16. Performance Considerations

### 16.1 Queue Size Management

- **Bounded queue**: `removeCommitted()` runs after each sync. For high-volume apps, a background cleanup job can run every N syncs.
- **Batch size**: Default push batch = 50, pull batch = 100. These are configurable.
- **Memory**: The sync queue is stored in IndexedDB, not memory. Only pending changes are loaded during sync.

### 16.2 IndexedDB Considerations

- The `_ctrodb_sync_changes` store grows linearly with mutations. In typical apps (hundreds to low thousands), this is fine.
- For apps with millions of mutations per session, implement a **change compaction** strategy: if the same record has multiple pending changes, keep only the latest.

```typescript
// Compaction: keep only the latest change per record
async #compactQueue(): Promise<number> {
  const all = await this.#tracker.getAll()
  const pending = all.filter((c) => c.status === "pending")

  // Group by (collection, recordId)
  const groups = new Map<string, SyncChangeRecord[]>()
  for (const change of pending) {
    const key = `${change.collection}:${change.recordId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(change)
  }

  let removed = 0
  for (const [key, changes] of groups) {
    if (changes.length > 1) {
      // Sort by timestamp descending, keep newest
      changes.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      const [keep, ...remove] = changes

      // If newest is a create or update, we can skip all previous
      // If newest is a delete, we keep only the delete
      if (keep.type === "delete") {
        // Remove all previous mutations for this record
        for (const r of remove) {
          await this.#adapter.delete(this.storeName, r.id)
          removed++
        }
      } else {
        // Keep the latest update, remove all prior
        for (const r of remove) {
          await this.#adapter.delete(this.storeName, r.id)
          removed++
        }
      }
    }
  }

  return removed
}
```

### 16.3 Network Efficiency

- **Batch pushes**: 50 changes per request instead of 50 individual requests.
- **Cursor-based pulls**: Only new changes since last sync. No full-table scans.
- **Conditional pull**: Filter by collection list when not all collections sync.
- **Debounced auto-sync**: Rapid mutations don't trigger individual network requests.

---

## 17. Future Work (v2.x)

| Feature | Why v2.x |
|---|---|
| **CRDT-based sync** | For collaborative editing (Operational Transform / CRDT). Massively more complex. |
| **P2P sync** (WebRTC) | For local-first apps without a central server. |
| **Streaming pull** (Server-Sent Events) | Alternative to WebSocket for real-time push over HTTP. |
| **Migration-aware sync** | Handle schema migrations alongside sync (strategy for transforming old-version records). |
| **Encrypted sync** | End-to-end encryption of sync payloads. |
| **Selective sync per record** (e.g., ownership-based) | Server-side filter predicates for pull. |
| **Sync pause/resume** | Explicit pause (e.g., on battery saver, metered connection). |
| **Conflict preview** | UI for users to manually resolve conflicts (before auto-resolve). |
| **Offline sync analytics** | Track sync success rates, average latency, conflict rates. |
| **Attachment/binaries sync** | Sync files alongside records (separate store, chunked upload). |
| **IndexedDB-based change cursor** | Use IndexedDB key cursor instead of timestamp-based. More efficient for large queues. |
| **Optimistic sync with undo** | Apply local changes immediately, revert if server rejects. |
| **Sync groups** (scoped to user/tenant) | Different sync endpoints per group. |

---

## Appendix A: Full File Manifest

```
src/
├── sync/
│   ├── index.ts              — Barrel exports
│   ├── types.ts              — All sync types
│   ├── change-tracker.ts     — ChangeTracker class
│   ├── conflict-resolver.ts  — ConflictResolverEngine
│   ├── sync-engine.ts        — SyncEngine orchestrator
│   ├── sync-plugin.ts        — syncPlugin() factory
│   ├── http-transport.ts     — HttpTransport
│   ├── ws-transport.ts       — WsTransport
│   └── devtools.ts           — inspectSyncQueue, retryFailedSync, etc.
├── index.ts                  — + syncPlugin, HttpTransport, types exports
├── database.ts               — + plugin(), sync(), onSync(), syncStatus
├── react.ts                  — + useSyncStatus(), useSync()
└── types.ts                  — + sync?: boolean on CollectionSchema

tests/
├── unit/
│   └── sync/
│       ├── change-tracker.test.ts
│       ├── conflict-resolver.test.ts
│       ├── http-transport.test.ts
│       └── ws-transport.test.ts
├── integration/
│   └── sync-flow.test.ts

examples/sync/
├── server-node/
│   └── src/
│       ├── index.ts
│       ├── routes/push.ts
│       ├── routes/pull.ts
│       ├── routes/ws.ts
│       └── store.ts
├── server-supabase/
│   └── README.md
└── README.md
```

## Appendix B: Implementation Order

```
Phase 1 ── Types & ChangeTracker       (src/sync/types.ts, change-tracker.ts)
Phase 2 ── Conflict Resolver           (src/sync/conflict-resolver.ts)
Phase 3 ── Sync Engine                 (src/sync/sync-engine.ts)
Phase 4 ── HTTP Transport              (src/sync/http-transport.ts)
Phase 5 ── Plugin & DB Integration     (src/sync/sync-plugin.ts, changes to database.ts, index.ts, types.ts)
Phase 6 ── React Hooks                (changes to src/react.ts)
Phase 7 ── WebSocket Transport         (src/sync/ws-transport.ts)
Phase 8 ── Multi-Tab & Background Sync (changes to sync-engine.ts, change-tracker.ts)
Phase 9 ── Dev Tools                   (src/sync/devtools.ts)
Phase 10 ─ Server Examples             (examples/sync/)
```

Each phase builds on the previous. Phases 7-10 can be developed in parallel after Phase 6 is complete.
