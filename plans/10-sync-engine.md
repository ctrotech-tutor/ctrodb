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

This section is the definitive reference for how the sync engine behaves under failure, what guarantees it provides, and what application developers must handle themselves. It is organized into seven sub-sections:

- **15.1 Formal State Machine** — exact transitions and invariants for sync change records
- **15.2 Edge Case Matrix** — all known edge cases, their severity, handling mechanism, and status (implemented/planned)
- **15.3 Error Recovery Matrix** — error types with detection, recovery, and developer guidance
- **15.4 Defensive Programming** — runtime guards, validation, and circuit breakers
- **15.5 Monitoring & Observability** — recommended logs, metrics, and alerting for production deployments
- **15.6 Verified: Defensive Measures Already in Code** — cross-reference to implemented guards with test verification
- **15.7 Production Readiness Summary** — scoring by category with prioritized fix list

---

### 15.1 Formal State Machine

Every `SyncChangeRecord` in `_ctrodb_sync_changes` follows a strict state machine. Understanding this is essential for reasoning about correctness.

```
                +-- retry ---> pending ──────> syncing ──> committed ──> [deleted]
                |                                  |
                ^                                  v
          [init crash recovery]               failed
```

#### 15.1.1 States

| State | Meaning | Visible to `getPending()` | Visible to `getFailed()` |
|---|---|---|---|
| `pending` | Recorded locally, waiting to sync | ✅ | ❌ |
| `syncing` | Currently being pushed to server | ❌ | ❌ |
| `committed` | Accepted by server, awaiting cleanup | ❌ | ❌ |
| `failed` | Rejected by server or transport error | ❌ | ✅ |

#### 15.1.2 Transitions

| From | To | Trigger | Where |
|---|---|---|---|
| `pending` | `syncing` | `markSyncing(ids)` at start of push batch | `sync-engine.ts:#pushChanges` |
| `syncing` | `committed` | `markCommitted(id)` after server accepts | `sync-engine.ts:#pushChanges` |
| `syncing` | `failed` | `markFailed(id, error)` after server rejects | `sync-engine.ts:#pushChanges` |
| `syncing` | `pending` | `markPending(id)` on network error | `sync-engine.ts:#pushChanges` (catch block) |
| `syncing` | `pending` | `init()` on startup (crash recovery) | `change-tracker.ts:init` |
| `failed` | `pending` | `markPending(id)` via `retryFailedSync()` or devtools | `devtools.ts:retryFailedSync` |
| `pending` | `committed` | `markCommitted(id)` after conflict resolution | `sync-engine.ts:#resolveConflict` |
| `committed` | `[deleted]` | `removeCommitted()` at end of sync cycle | `change-tracker.ts:removeCommitted` |

#### 15.1.3 Invariants

1. No concurrent sync: `#isSyncing` prevents overlapping `sync()` calls. If a second call arrives while the first is executing, it returns early.
2. All or nothing per batch: On network failure during push, **all** changes in the batch are reverted to `pending`. Partial marking (some committed, some failed, some reverted) only happens after a successful server response with explicit accept/conflict/error fields.
3. Idempotent push: Committed changes are removed after `removeCommitted()`. If the process crashes before removal, the next `init()` leaves them as `committed`, and they are cleaned up on the next successful sync. They are never re-pushed.
4. No duplicates in queue: Each change has a unique `id` (UUID). The primary key constraint on the store prevents accidental duplicates.
5. Monotonic cursor: `lastPullCursor` only moves forward. It is persisted via `setMetadata` after each successful pull cycle.

---

### 15.2 Edge Case Matrix

Every entry includes: scenario, severity (🟥 critical / 🟧 high / 🟨 medium / 🟩 low), current handling status, and the file/line where it's addressed.

#### 15.2.1 Data Integrity

| # | Edge Case | Severity | Handling | Status |
|---|---|---|---|---|
| 1 | **Mutation during active sync** | 🟩 Low | Sync takes a snapshot of pending changes at the start. Concurrent mutations append new records that are picked up in the next cycle. The current cycle is not affected. | ✅ Implemented `sync-engine.ts:263` |
| 2 | **Same record mutated N times before sync** | 🟩 Low | Queue retains all N mutations. On push, the server processes them in order (create → updates → delete). Net state after all N is correct. For efficiency, `compactSyncQueue()` (devtools) reduces N→1 per (collection, recordId). | ✅ Implemented `devtools.ts:compactSyncQueue` |
| 3 | **Create → delete before sync** | 🟩 Low | Both records pushed in order. Server creates then deletes. Net effect: record never persists on server. Both committed locally. | ✅ Implemented (by queue ordering) |
| 4 | **Update → delete before sync** | 🟩 Low | Same as above: update pushed first, delete second. Net: record deleted. | ✅ Implemented |
| 5 | **Delete → create before sync** | 🟩 Low | Delete pushed first (no-op if server didn't have it), then create. Net: record created on server. | ✅ Implemented (queue FIFO) |
| 6 | **Partial batch acceptance with conflicts** | 🟧 High | Server returns `accepted`, `conflicts`, and `errors` in a single response. The engine handles each category: accepted→committed, conflicts→resolve→committed, errors→failed. All in one pass. | ✅ Implemented `sync-engine.ts:288-300` |
| 7 | **Server accepts a change that was already in-flight from another tab** | 🟨 Medium | Tab A pushes change C1. Server accepts. Tab A broadcasts via `BroadcastChannel`. Tab B's `triggerSync()` fires. Tab B has C1 in its queue (was created locally via the same user action in both tabs). Tab B pushes C1 — server accepts again but reports it as an update. C1 is committed and cleaned up by both tabs. **No duplicate data** because the server's change ID differs from the local change ID. | ✅ Implemented (unique UUID per local change) |
| 8 | **Record deleted locally while pending create exists** | 🟩 Low | Queue has [create(C1), delete(D1)]. Server receives create (record created), then delete (record deleted). Net: record gone. Both C1 and D1 committed. | ✅ Implemented |
| 9 | **Pull re-applies a change that was just conflict-resolved** | 🟧 High | Push detects conflict → resolver picks remote → applies remote via `adapter.update()`. Then pull phase fetches the same remote change (server just accepted it as the result of push). `#applyRemoteChange` runs again: record exists, no pending local changes → `adapter.update()` with same data. **Result**: redundant but idempotent write. | ✅ Implemented (pull apply is idempotent for updates) |
| 10 | **Queue compaction (`compactSyncQueue`) runs during active sync** | 🟥 Critical | DevTools function reads all pending, deduplicates, and deletes old entries. If a concurrent `sync()` has marked some of those as `syncing` (mid-push), the compaction could delete records that are currently being sent to the server. Those changes would be lost forever. **Mitigation**: `compactSyncQueue` must only be called when `engine.status.isSyncing === false`. The function itself should verify each record is still `pending` or `failed` before deleting. | ⚠️ **Bug**: GAP-3 — needs fix |

#### 15.2.2 Concurrency & Multi-Tab

| # | Edge Case | Severity | Handling | Status |
|---|---|---|---|---|
| 11 | **Two tabs sync simultaneously** | 🟧 High | `#isSyncing` prevents concurrent sync within a tab. Across tabs, each tab has its own engine instance. Both push their local changes. Server merges both (or returns conflicts). Tab A's pull fetches Tab B's changes (and vice versa). BroadcastChannel triggers re-renders. | ✅ Implemented (Phase 8) |
| 12 | **BroadcastChannel message from Tab B arrives while Tab A is syncing** | 🟩 Low | Tab A's `BroadcastChannel.onmessage` calls `triggerSync()` which sets a debounce timer. Since `sync()` is already running (`#isSyncing`), the debounce will fire after sync completes. | ✅ Implemented `sync-engine.ts:460-471` |
| 13 | **Tab B creates a change for a record that Tab A just synced** | 🟨 Medium | Tab A's change is committed and removed from queue. Tab B creates a new change. Tab A's BroadcastChannel triggers re-render. Tab B's next sync pushes the new change. Server handles it normally. | ✅ Implemented |
| 14 | **Three tabs: Tab A creates, Tab B syncs, Tab C syncs** | 🟨 Medium | Tab A creates → change broadcast to B and C. Tab B syncs → pushes A's change (if B was the originator... wait, B only pushes its own changes. Tab B does NOT push Tab A's changes because the change belongs to Tab A). Tab B's pull fetches A's change from server (after A syncs). Tab C does the same. Each tab independently pulls the change. | ✅ Implemented (changes are per-originator) |

#### 15.2.3 Crash & Recovery

| # | Edge Case | Severity | Handling | Status |
|---|---|---|---|---|
| 15 | **Tab crash mid-push (after `markSyncing`, before response)** | 🟥 Critical | `init()` on next load finds changes stuck in `syncing` and reverts them to `pending`. They will be pushed again. The server may have already received and processed them (idempotent on server). | ✅ Implemented `change-tracker.ts:16-25` |
| 16 | **Tab crash mid-pull (after applying some remote changes)** | 🟧 High | The applied changes are persisted (adapter.create/update/delete is durable). The cursor is NOT saved (it's saved at the end of the pull loop). Next sync re-pulls from the old cursor, re-applying already-applied changes. **Idempotent**: create becomes update, update repeats, delete is guarded by existence check. | ✅ Implemented (idempotent pull apply) |
| 17 | **Tab crash after `removeCommitted()` deletes committed records** | 🟩 Low | All committed changes were successfully synced. No data loss. The crash happened after cleanup, which is a no-op for correctness. | ✅ Implemented (cleanup is post-sync) |
| 18 | **IndexedDB transaction wrapping all adapter operations during sync** | 🟧 High | The sync engine intentionally does NOT use `adapter.transaction()` — each `create/update/delete` is its own transaction. This prevents "transaction too long" errors and allows partial progress. The tradeoff is no atomicity across the entire sync cycle. | ✅ Implemented (by design) |
| 19 | **`markSyncing` fails midway (after 5 of 50 IDs)** | 🟥 Critical | Some records are stuck in `syncing` — invisible to `getPending()` — until the next `init()` resets them. During this window, those records will never be pushed. **Mitigation**: the engine should catch write failures in `markSyncing` and revert already-written IDs to `pending`. | ⚠️ **Bug**: GAP-2 — needs fix in `change-tracker.ts:85-93` |

#### 15.2.4 Server-Side

| # | Edge Case | Severity | Handling | Status |
|---|---|---|---|---|
| 20 | **Server returns conflict for a create (duplicate recordId)** | 🟨 Medium | Rare if using UUIDs for recordId. If it happens, the ConflictResolver determines which version wins. | ✅ Implemented `conflict-resolver.ts` |
| 21 | **Server prunes change log (cursor becomes stale)** | 🟧 High | Client's `lastPullCursor` points to a change that no longer exists. The server's `findIndex()` returns `-1`, so `startIndex = 0` — all changes are sent. The client receives all available changes (not just diffs). This is correct but potentially expensive. **Mitigation**: Server should return a `reset: true` flag to indicate the client should clear its cursor and re-pull from scratch. | ❌ **Not implemented** (server-side feature) |
| 22 | **Server rolls back after accepting changes** | 🟧 High | Server accepted changes (client marked committed, cleaned up). Server crashes before persisting. Changes are lost. **Mitigation**: This is a server concern, not client. The client has no way to detect this unless the server returns a "you're missing changes" signal on next push. The sync protocol assumes server writes are durable once `accepted` is returned. | ❌ **Not implemented** (requires server-side write-ahead log) |
| 23 | **Server returns fewer changes than `batchSize` with `hasMore: true`** | 🟩 Low | The engine checks `hasMore && result.changes.length > 0`. If changes is empty but hasMore is true, the loop terminates. No infinite loop. | ✅ Implemented `sync-engine.ts:400` |
| 24 | **Server returns duplicate changes across paginated pulls** | 🟩 Low | Cursor-based pagination should prevent this. If a server bug causes duplicates, applying them is idempotent (create→update, update→update, delete guarded by existence). | ✅ Implemented (idempotent apply) |
| 25 | **Unlimited pull pagination (OOM)** | 🟨 Medium | If the server keeps returning `hasMore: true`, the pull loop could iterate indefinitely. There is no hard cap on pull iterations. **Mitigation**: Add a `maxPullPages` constant (e.g., 1000) or a total changes cap. | ⚠️ **Gap**: GAP-7 |

#### 15.2.5 Network & Transport

| # | Edge Case | Severity | Handling | Status |
|---|---|---|---|---|
| 26 | **Network timeout during push** | 🟧 High | Transport throws (fetch timeout or AbortSignal). `#pushChanges` catches → reverts all batch IDs to `pending`. `sync()` catch → `#scheduleBackoff`. | ✅ Implemented `sync-engine.ts:281-285` |
| 27 | **Network timeout during pull** | 🟧 High | Transport throws. `#pullChanges` propagates the error to `sync()` catch. The cursor is NOT updated. Next sync re-pulls from the same cursor. **Note**: any changes already applied in this cycle (from earlier pages) remain applied. Next cycle may re-apply them (idempotent). | ✅ Implemented `sync-engine.ts:380-401` |
| 28 | **Connection lost mid-request** | 🟧 High | Same as timeout — `fetch` or WebSocket throws network error. Engine reverts push batch to pending and schedules retry. | ✅ Implemented |
| 29 | **Server returns 413 (Request Entity Too Large)** | 🟨 Medium | Push batch is too large. The engine treats this as a server error: entire batch reverted to pending. After max backoff retries, they stay in `failed` status. **Mitigation**: Client should reduce batch size on 413 and retry. | ⚠️ **Gap**: no batch-size-backoff on 413 |
| 30 | **Server returns 429 (Rate Limited)** | 🟧 High | The engine treats it as any server error (backoff + retry). The default backoff already includes jitter, which helps avoid synchronized retries. However, the engine does NOT respect the `Retry-After` header. | ⚠️ **Gap**: `Retry-After` header not parsed |
| 31 | **Server returns 401 (Unauthorized)** | 🟧 High | Push/pull fails with 401. The engine marks changes as `pending` (not `failed`) and schedules backoff. This will keep retrying with auth errors. **Better**: detect 401 and stop retrying, emit an auth-required event. | ⚠️ **Gap**: GAP-12 (AbortError treated as failure) + 401 not special-cased |
| 32 | **Server goes down mid-operation, HTTP transport `isConnected` stays `true`** | 🟧 High | `HttpTransport.connect()` is a one-shot HEAD request. Once `connected` is set to `true`, it never reverts (unless `disconnect()` is called). A server failure mid-operation will cause push/pull to throw, but `status.isConnected` remains `true`. **Mitigation**: Track push/pull failures and auto-set `#connected = false` on transport errors. | ⚠️ **Bug**: GAP-16 |
| 33 | **WebSocket reconnects with exponential backoff indefinitely** | 🟨 Medium | `WsTransport` has a `maxReconnectAttempts` (default 10). After exhausting retries, it stops. However, `SyncEngine` has no circuit breaker — it will keep calling `sync()` which tries to push/pull via a disconnected transport, which throws, which triggers backoff, which calls `sync()` again. This creates a retry loop with a 5-minute interval that never terminates. | ⚠️ **Gap**: GAP-1 — no circuit breaker |
| 34 | **WebSocket message arrives for a timed-out request** | 🟩 Low | The request is removed from `#pendingRequests` on timeout. When the response arrives, `requestId` is not found, and the message is silently dropped. This is correct behavior but opaque to debugging. | ✅ Implemented (silent drop) |
| 35 | **WebSocket `onmessage` fires synchronously during `send()`** | 🟨 Medium | Rare, but if a polyfill or stub WebSocket calls `onmessage` synchronously in `send()`, the response may arrive before `#waitForResponse` sets up the pending entry. The response is dropped. The request hangs until the 30s timeout. **Mitigation**: Set up the pending entry in `#waitForResponse` BEFORE calling `send()`. | ⚠️ **Bug**: GAP-4 |

#### 15.2.6 Timing & Ordering

| # | Edge Case | Severity | Handling | Status |
|---|---|---|---|---|
| 36 | **Clock skew between clients** | 🟨 Medium | Client timestamps are used for LWW conflict resolution. If Client A's clock is 5 minutes ahead of Client B's, A's changes always win in LWW. **Mitigation**: Server should normalize timestamps or use its own `serverTimestamp` as authoritative. The engine already stores `serverTimestamp` from `accepted` responses. | ✅ Partially implemented (serverTimestamp stored but not used for LWW — uses local timestamp) |
| 37 | **Push then pull: pull returns the change that was just pushed** | 🟩 Low | After push, the change is on the server. Pull fetches it. `#applyRemoteChange` sees the record exists (push just updated it) and applies the same data again. Idempotent. | ✅ Implemented |
| 38 | **Abort during paginated pull (page 1 applied, page 2 not retrieved)** | 🟧 High | Cursor is NOT updated because pull never completed. Next sync re-pulls from the original cursor, getting page 1 again AND page 2. Page 1 changes are re-applied (idempotent). Correct but slightly wasteful. | ✅ Implemented (cursor saved only after full pull cycle) |
| 39 | **User navigates away mid-sync** | 🟩 Low | If the component unmounts and calls `engine.destroy()`, the abort signal cancels the in-flight request. The sync is interrupted. Next init() recovers stuck changes. | ✅ Implemented |
| 40 | **Auto-sync timer fires while `isSyncing` is true (long sync cycle)** | 🟩 Low | The timer callback calls `sync()` which returns early due to `#isSyncing`. The missed cycle is not re-queued. **Mitigation**: Acceptable — the next timer tick will fire. For intervals shorter than the sync cycle, some ticks are skipped. | ✅ Implemented `sync-engine.ts:204` |

#### 15.2.7 Storage & Capacity

| # | Edge Case | Severity | Handling | Status |
|---|---|---|---|---|
| 41 | **Sync queue grows to millions of records** | 🟧 High | `getPending()` loads ALL records into memory (via `adapter.findAll`), then filters/sorts in JS. With millions of records, this will OOM. **Mitigation**: Implement paginated reads using IndexedDB indexes (status index + timestamp index). | ⚠️ **Gap**: Phase 1 decision deferred index support; queue is assumed small |
| 42 | **IndexedDB quota exceeded** | 🟧 High | Sync queue additions fail. `tracker.append()` throws. The app's `collection.create()` also fails because the adapter can't write. **Mitigation**: The app should listen for QuotaExceededError via `navigator.storage.estimate()` and show a storage warning. | ❌ **Not implemented** (app responsibility) |
| 43 | **`crypto.randomUUID()` throws (permissions policy restriction)** | 🟩 Low | In some iframe/fenced-frame contexts, `crypto.randomUUID()` exists but throws. The current fallback check (`typeof crypto.randomUUID === "function"`) passes, then the call throws. **Mitigation**: Wrap in try/catch. | ⚠️ **Bug**: BUG-1 in `change-tracker.ts` |
| 44 | **`fetch`/`WebSocket` not available (SSR/Node <18)** | 🟨 Medium | Transport constructors don't check for global availability. A helpful error should be thrown at construction time, not at first use. | ⚠️ **Gap**: BUG-4, BUG-5 |

---

### 15.3 Error Recovery Matrix

For every error the sync engine can encounter, this table documents the detection mechanism, the recovery strategy, the developer's responsibility, and whether the behavior is configurable.

#### 15.3.1 Transport Errors

| Error | Detected By | Auto-Recovery | Developer Responsibility | Configurable |
|---|---|---|---|---|
| **Network unavailable** (no internet) | `fetch`/WebSocket throws `TypeError` or `Error` | Mark push batch → `pending`, schedule backoff. Pull → error propagated, retry next cycle. | Listen to `syncStatus.isConnected` to show offline UI. Listen for phase: "error" events. | Backoff params (`retryMaxAttempts`, `autoSync.retryMaxDelayMs`) |
| **Request timeout** | `AbortSignal.timeout()` fires; transport throws `TimeoutError` | Same as network unavailable | Same as above | `HttpTransport.timeoutMs`, `WsTransport` request timeout (30s hardcoded) |
| **Server 4xx** (client error) | `response.ok === false` | Push: marks individual changes as `failed` per-change for validation errors. 401/403 treated as batch failure → all reverted to `pending`. | Must re-authenticate on 401. Fix invalid data for 400/422. | None (server-driven) |
| **Server 5xx** (server error) | `response.ok === false` | Batch reverted to `pending`, backoff + retry. Same as network error. | Report to server ops. | Same as network error |
| **Server 429** (rate limit) | `response.status === 429` | Same as 5xx. Does NOT parse `Retry-After` header. | Implement application-level rate limiting if needed. | None |
| **Server 413** (payload too large) | `response.status === 413` | Same as 5xx. No automatic batch-size reduction. | Reduce `pushBatchSize` config. Implement batch-size halving on 413. | `pushBatchSize` (static) |
| **Connection closed** (WebSocket) | `onclose` event | Auto-reconnect with exponential backoff (up to `maxReconnectAttempts`). All pending requests rejected. | Re-subscribe to `onServerPush` after reconnect. | `wsTransport.reconnectInterval`, `maxReconnectAttempts` |
| **WebSocket connect timeout** | `setTimeout` fires before `onopen` | Cleans up socket. Schedules reconnect. | Same as connection closed. | Connection timeout (10s hardcoded) |
| **Malformed server response** (invalid JSON, missing fields) | `JSON.parse` throws, or response validation fails | Push/pull throws → batch reverted → retry. If persistent, changes stay `pending`. | Implement custom transport with better error handling. | ❌ No response validation (GAP-6) |

#### 15.3.2 Queue & State Errors

| Error | Detected By | Auto-Recovery | Developer Responsibility | Configurable |
|---|---|---|---|---|
| **Stuck `syncing` changes** (crash mid-sync) | `init()` finds records with `status === "syncing"` | Reverts to `pending`, increments `retries`. | None — automatic on next page load. | None |
| **Duplicate change ID** (UUID collision) | `adapter.create()` throws (primary key violation) | The `append()` call throws. The `onAfterCreate/Update/Delete` hook propagates the error. The collection operation itself fails. | The app must handle `collection.create()` errors. | None (use `crypto.randomUUID()` which is collision-resistant) |
| **Queue store missing** | `adapter.findAll()` throws on first access | The plugin's `storeNames` should create it. If not, the engine crashes on first sync. | Verify the sync plugin is registered with `storeNames: ["_ctrodb_sync_changes"]`. | Plugin config |
| **Adapter metadata unavailable** | `getMetadata`/`setMetadata` throws | The engine treats cursor and lastSyncAt as null. Continues without persisted state. | Ensure the adapter supports metadata operations. | Adapter implementation |

#### 15.3.3 Conflict Resolution Errors

| Error | Detected By | Auto-Recovery | Developer Responsibility | Configurable |
|---|---|---|---|---|
| **Custom resolver throws** | `ConflictResolverEngine.resolve` catch | Falls back to LWW. The conflict change remains `syncing` and will be retried. | Ensure custom resolvers are pure and never throw. | Custom resolver function |
| **Invalid strategy name** | Switch statement in `resolve` | Throws. The sync cycle fails, changes revert to `pending`, backoff retries. | Use a valid `ConflictStrategy`. | `strategy` config |
| **Server returns invalid conflict data** (missing fields) | Property access on `undefined` in `#resolveConflict` | Throws. Same as above. | Ensure server returns correct conflict format per API contract. | None |

#### 15.3.4 Sync Engine Lifecycle Errors

| Error | Detected By | Auto-Recovery | Developer Responsibility | Configurable |
|---|---|---|---|---|
| **`sync()` called before `init()`** | `#tracker` may not be initialized | `#tracker.init()` was called in `engine.init()`. If not called, `getPending()` may work (adapter returns empty) but crash recovery is skipped. | Always call `connect()` (which calls `engine.init()`) before calling `sync()`. | None |
| **`destroy()` called during active sync** | AbortController fires | In-flight request is cancelled. Sync returns early with `AbortError`. Stuck `syncing` changes recovered on next `init()`. | Ensure `destroy()` cleanup runs. | None |
| **AbortError in sync catch block triggers backoff** | `sync()` catch checks error type | Currently does NOT check — all errors trigger backoff. **Bug**: an intentional abort (user cancels sync) causes unwanted retry. | None on developer side. Engine should skip backoff for `AbortError`. | ⚠️ **Bug**: GAP-12 |

---

### 15.4 Defensive Programming

This section lists runtime guards, assertions, and circuit breakers that the engine employs — and identifies where gaps remain.

#### 15.4.1 Implemented Guards

| Guard | Location | What It Prevents |
|---|---|---|
| `#isSyncing` re-entrance guard | `sync-engine.ts:204` | Concurrent sync cycles |
| `#backoffTimer !== null` guard | `sync-engine.ts:483` | Multiple simultaneous backoff timers |
| `typeof window !== "undefined"` check | `sync-engine.ts:134` | SSR/Node crash on `window.addEventListener` |
| `BroadcastChannel` try/catch | `change-tracker.ts:57-68` | Node environment crash on `new BroadcastChannel()` |
| `transport.connect()` try/catch | `sync-engine.ts:105-110` | Offline-start where transport fails to connect |
| Push network failure → revert all to pending | `sync-engine.ts:281-285` | Partial state where some batch items marked different status |
| `removeCommitted()` empty-list guard | `change-tracker.ts:139` | Deletion operation on empty array |
| `change.data === null` skip in pull apply | `sync-engine.ts:421` | Null data crash on remote apply |
| Local existence check in pull delete | `sync-engine.ts:437-439` | Delete on non-existent record (IndexedDB may throw) |
| Subscriber error isolation | `sync-engine.ts:533-537` | One bad subscriber listener cannot crash engine |
| `conflict.merged` null guard | `sync-engine.ts:349-362` | Null merge result causing write crash |
| `onAfterDelete` oldRecord null coerce | `sync-plugin.ts:47-48` | Null `prevData` in change record |
| `#mergeSignals` dual AbortSignal handling | `http-transport.ts:118-142` | Proper cancellation when both timeout and external signal are provided |
| WebSocket `#send` readyState check | `ws-transport.ts:232-236` | Prevent send on disconnected socket |
| WebSocket reconnect capped at maxAttempts | `ws-transport.ts:315-317` | Infinite reconnect loop |
| Invalid timestamp → `NaN` → `0` fallback | `conflict-resolver.ts:64-67` | Crash on malformed timestamp |
| `findById` null in `markFailed` | `change-tracker.ts:106-109` | Crash on concurrent deletion of change record |
| Compact queue groups by (collection, recordId) | `devtools.ts:113-122` | Correct deduplication across collections |
| Event log ring-buffer shift | `devtools.ts:38-40` | Unbounded memory growth in event log |

#### 15.4.2 Gap: Guards That Should Be Added

| Missing Guard | Priority | Suggested Implementation |
|---|---|---|
| **AbortError discrimination in `sync()` catch** | 🟧 High | Check `if ((error as DOMException).name === 'AbortError')` — skip `lastError`, skip `scheduleBackoff()`, re-throw or return cleanly |
| **Response validation for push/pull** | 🟨 Medium | Verify `accepted[i].id` is in the batch set. Verify `changes[i].id` is non-empty. Throw descriptive error on malformed response. |
| **Max pull pages** | 🟨 Medium | Add `maxPullPages = 1000` constant in `#pullChanges`. Throw if exceeded to break infinite loop. |
| **Backoff circuit breaker** | 🟧 High | After N consecutive failures (configurable, default 50), enter "dead" state — stop auto-sync until user manually triggers sync or reconnects |
| **`markSyncing` transactional rollback** | 🟥 Critical | If the 3rd of 50 `update` calls fails, revert the first 2: `for (const id of done) { await this.markPending(id) }` |
| **`compactSyncQueue` re-check status before delete** | 🟥 Critical | `const current = await this.getById(r.id); if (current?.status === "pending" || current?.status === "failed") { ... }` |
| **`isConnected` auto-decline on transport error** | 🟧 High | In `HttpTransport`, set `#connected = false` when push/pull throws a network error. Keep it false until the next successful `connect()` |
| **`Retry-After` header parsing** | 🟩 Low | On 429, parse `Retry-After` (seconds or HTTP-date) and use as backoff delay |
| **413 batch-size backoff** | 🟩 Low | On 413, halve `pushBatchSize` for this batch and retry without other changes |
| **Globals existence checks** | 🟩 Low | Verify `typeof fetch !== "undefined"` and `typeof WebSocket !== "undefined"` in transport constructors |

#### 15.4.3 State Invariant Enforcement

The engine does not currently enforce state invariants at runtime (no assertions). In production, assertions are typically removed. However, we recommend the following **debug-mode assertions** that can be toggled via a `__DEV__` flag:

```typescript
// Debug assertions — stripped in production builds
function assertInvariant(condition: boolean, message: string): void {
  if (typeof __DEV__ !== "undefined" && __DEV__ && !condition) {
    console.error(`[ctrodb] Sync invariant violated: ${message}`)
  }
}

// Usage in critical paths:
assertInvariant(
  new Set(batchIds).size === batchIds.length,
  "Batch IDs must be unique",
)
assertInvariant(
  acceptedIds.every((id) => batchIds.includes(id)),
  "Server returned acceptance for non-batch IDs",
)
```

---

### 15.5 Monitoring & Observability

Production deployments require visibility into sync health. This section covers recommended instrumentation.

#### 15.5.1 Emitted Events (Already Available)

The engine emits `SyncEvent` at each phase. These are the primary observability mechanism.

| Phase | When | Payload |
|---|---|---|
| `push` | Start of push phase | `{ phase: "push" }` |
| `pull` | Start of pull phase | `{ phase: "pull", progress: SyncProgress }` |
| `conflict` | After conflict resolution | `{ phase: "conflict", progress: SyncProgress }` |
| `complete` | Sync cycle finished successfully | `{ phase: "complete", progress: SyncProgress }` |
| `error` | Sync cycle failed | `{ phase: "error", error: Error }` |

**Recommended production usage**:

```typescript
db.onSync((event) => {
  if (event.phase === "error") {
    captureError(event.error)  // Send to Sentry/Datadog
  }
  if (event.phase === "complete") {
    metrics.recordSyncDuration(
      Date.now() - syncStartTime,
      event.progress.pushed,
      event.progress.pulled,
    )
  }
  if (event.progress?.failed > 0) {
    metrics.increment("sync.changes.failed", event.progress.failed)
  }
})
```

#### 15.5.2 Recommended Metrics (App-Level)

Applications should track these metrics for production monitoring:

| Metric | Type | How to Measure | Alert Threshold |
|---|---|---|---|
| `sync.cycle.duration` | Histogram | Time from push start to complete event | >30s (p95) |
| `sync.changes.pending` | Gauge | `db.getPendingCount()` at 30s interval | >1000 |
| `sync.changes.failed` | Counter | Sum of `progress.failed` across cycles | >10 in 5 minutes |
| `sync.errors.total` | Counter | Count of error-phase events | >5 in 5 minutes |
| `sync.backoff.delay` | Gauge | Current backoff delay (expose via devtools) | >60s |
| `sync.cycles.skipped` | Counter | Count of `isSyncing`-guard rejections | >100 in 5 minutes |
| `sync.conflict.count` | Counter | Sum of `progress.conflicts` across cycles | >1 per user per hour |
| `sync.queue.size` | Gauge | Total records in sync store | >10000 |
| `sync.connectivity` | Gauge | `syncStatus.isConnected` (0/1) | 0 for >5 minutes |
| `sync.last.success` | Gauge | Unix timestamp of last complete event | >30 minutes ago |

#### 15.5.3 Recommended Logging Levels

| Level | Events | Example |
|---|---|---|
| `error` | Sync cycle failures, transport errors, auth failures | `Sync cycle failed: Network error` |
| `warn` | Conflicts, partial failures, high retries, queue compaction | `3 changes marked failed: Validation failed` |
| `info` | Sync cycle start/complete, connectivity changes | `Sync complete: pushed 5, pulled 2, conflicts 1` |
| `debug` | Per-change progress, state transitions, backoff scheduling | `Change abc-123: pending → syncing` |

The engine itself does not produce log output (it emits events). Applications should attach an event listener that routes events to their chosen logger:

```typescript
db.onSync((event) => {
  if (event.phase === "error") {
    logger.error({ component: "sync" }, "Sync failed", { error: event.error })
  }
  if (event.phase === "complete") {
    logger.info({ component: "sync" }, "Sync complete", { progress: event.progress })
  }
})
```

#### 15.5.4 Developer Tools Integration

The built-in devtools (`src/sync/devtools.ts`) provide runtime introspection:

- `inspectSyncQueue(db)` — Full queue snapshot (pending/syncing/committed/failed with stats)
- `getSyncStats(db)` — Lightweight counts without loading all records
- `createSyncEventLog(db, maxSize)` — Ring-buffer of last N sync events for debugging
- `retryFailedSync(db)` — Manual retry of failed changes
- `clearCommittedSync(db)` — Manual cleanup of committed changes
- `compactSyncQueue(db)` — Deduplicate pending/failed per (collection, recordId)
- `useSyncQueue()` / `SyncDevPanel` — React component for real-time queue inspection

These are intended for development mode and admin UIs, not production monitoring.

#### 15.5.5 Health Check Endpoint (Server-Side)

Reference server (`examples/sync/server-node/`) exposes `GET /health` returning `{ status: "ok" }`. Production deployments should extend this with:

```json
{
  "status": "ok",
  "uptime": 3600,
  "pendingChanges": 0,
  "connectedClients": 42,
  "lastPushAt": "2026-06-30T12:00:00Z",
  "lastErrorAt": null,
  "changeLogSize": 15000
}
```

---

### 15.6 Verified: Defensive Measures Already in Code

For reference, the following production-safety measures are already implemented and tested. These are not theoretical — they exist in the codebase at the listed locations:

| Measure | Files | Verified By |
|---|---|---|
| Crash recovery (revert stuck `syncing` → `pending`) | `change-tracker.ts:16-25` | `sync-engine.test.ts` |
| Re-entrance guard (`#isSyncing`) | `sync-engine.ts:204` | `sync-engine.test.ts` |
| Push network failure → revert batch to pending | `sync-engine.ts:281-285` | Integration tests |
| Backoff with jitter (0.75-1.25x) | `sync-engine.ts:486-491` | Integration test |
| Debounce rapid `triggerSync()` calls | `sync-engine.ts:460-471` | Integration test |
| Idempotent pull application | `sync-engine.ts:414-443` | Integration tests |
| Signal merging (timeout + external abort) | `http-transport.ts:118-142` | `http-transport.test.ts` |
| WebSocket reconnect with exponential backoff | `ws-transport.ts:315-332` | `ws-transport.test.ts` |
| Subscriber error isolation | `sync-engine.ts:533-537` | `sync-engine.test.ts` |
| Event log ring-buffer cap | `devtools.ts:38-40` | `devtools.test.ts` |
| Crypto.randomUUID() fallback | `change-tracker.ts:35-38` | Implicit (tested in Node without crypto) |
| BroadcastChannel graceful fallback | `change-tracker.ts:57-68` | Node tests pass without BroadcastChannel |
| Online/offline detection | `sync-engine.ts:134-139` | `broadcast.test.ts` |
| Cursor persistence across restarts | `sync-engine.ts:99-102, 235-238` | Implicit (confirmed by integration tests) |
| Multi-tab cross-notification | `change-tracker.ts:57-68`, `sync-engine.ts:116-131` | `broadcast.test.ts` |
| Queue compaction (deduplication) | `devtools.ts:103-137` | `devtools.test.ts` |
| Configurable batch sizes | `sync-engine.ts:84-85` | Integration tests |
| Configurable auto-sync interval/debounce | `sync-engine.ts:88-90` | Integration tests |
| Transport connect error handling | `sync-engine.ts:105-110` | `sync-engine.test.ts` |
| AbortController per sync cycle | `sync-engine.ts:207` | `sync-engine.test.ts` |
| Persisted metadata (cursor, lastSyncAt) | `sync-engine.ts:235-238` | Confirmed by init/connect tests |
| Conflict resolution strategies (4 built-in) | `conflict-resolver.ts` | `conflict-resolver.test.ts` |
| Error isolation per subscriber | `sync-engine.ts:536` | `sync-engine.test.ts` (subscriber throws) |

---

### 15.7 Production Readiness Summary

| Category | Score | Notes |
|---|---|---|
| **Crash recovery** | ✅ Excellent | Stuck `syncing` reverted, idempotent push/pull, cursor restart | 
| **Error handling** | 🟧 Good | Most error paths handled. Missing: AbortError discrimination, 413/429 special handling |
| **State machine correctness** | ✅ Excellent | Formal transitions, no invalid states, all one-directional |
| **Concurrency safety** | ✅ Good | `#isSyncing`, per-tab engine isolation, BroadcastChannel coordination |
| **Network resilience** | 🟧 Good | Backoff + jitter, reconnect, debounce. Missing: circuit breaker, `isConnected` auto-decline |
| **Storage efficiency** | 🟨 Fair | `removeCommitted()` after each sync. Missing: indexed reads for large queues, compression |
| **Observability** | 🟧 Good | Events emitted at each phase, devtools for inspection. Missing: metrics hooks, logging level routing |
| **Test coverage** | ✅ Excellent (core), 🟧 Fair (transports) | 442 tests passing. HTTP + WS transports have unit tests but transport tests have some coverage gaps |
| **Defensive programming** | 🟧 Good | 22+ runtime guards. Missing: response validation, state invariants |

**Recommended actions before production launch** (in priority order):
1. Fix `markSyncing` rollback on partial failure (GAP-2)
2. Fix `compactSyncQueue` race with active sync (GAP-3)
3. Add AbortError discrimination (GAP-12)
4. Fix `isConnected` auto-decline on transport error (GAP-16)
5. Fix `crypto.randomUUID()` try/catch for permissions policy (BUG-1)
6. Add circuit breaker for permanent network failures (GAP-1)
7. Add response validation for transport returns (GAP-6)
8. Add maxPullPages guard (GAP-7)
9. Fix `status.pendingChanges` hardcoded zero (GAP-14/15)
10. Add `Retry-After` header parsing for 429 (GAP)

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
