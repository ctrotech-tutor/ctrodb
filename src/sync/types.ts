import type { ID } from "../types"

export type SyncChangeType = "create" | "update" | "delete"

export type SyncChangeStatus = "pending" | "syncing" | "committed" | "failed"

export type ConflictStrategy = "lww" | "client-wins" | "server-wins" | "custom"

export interface SyncChangeRecord {
  id: string
  collection: string
  recordId: ID
  type: SyncChangeType
  data: Record<string, unknown> | null
  prevData: Record<string, unknown> | null
  timestamp: string
  status: SyncChangeStatus
  retries: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

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

export type ConflictResolverFn = (
  conflict: SyncConflict,
) => ConflictResolution | Promise<ConflictResolution>

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
    type: SyncChangeType
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

export interface SyncPluginConfig {
  transport: SyncTransport
  strategy?: ConflictStrategy
  conflictResolver?: ConflictResolverFn
  autoSync?: boolean | { intervalMs?: number; debounceMs?: number }
  collections?: string[]
  pushBatchSize?: number
  pullBatchSize?: number
  retryMaxAttempts?: number
}

export interface SyncStatus {
  isSyncing: boolean
  isConnected: boolean
  lastSyncAt: string | null
  pendingChanges: number
  failedChanges: number
  lastError: string | null
}

export type SyncPhase = "push" | "pull" | "conflict" | "complete" | "error"

export interface SyncProgress {
  pushed: number
  pulled: number
  conflicts: number
  failed: number
}

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
