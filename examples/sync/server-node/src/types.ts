export type SyncChangeType = "create" | "update" | "delete"

export interface ServerChange {
  id: string
  collection: string
  recordId: string | number
  type: SyncChangeType
  data: Record<string, unknown> | null
  timestamp: string
}

export interface SyncConflict {
  changeId: string
  recordId: string | number
  collection: string
  local: Record<string, unknown> | null
  remote: Record<string, unknown> | null
  localTimestamp: string
  remoteTimestamp: string
  fieldConflicts: string[]
}

export interface PushRequestBody {
  changes: Array<{
    id: string
    collection: string
    recordId: string | number
    type: SyncChangeType
    data: Record<string, unknown> | null
    timestamp: string
  }>
}

export interface PushResponseBody {
  accepted: Array<{ id: string; serverTimestamp: string }>
  conflicts: SyncConflict[]
  errors: Array<{ id: string; error: string }>
}

export interface PullRequestBody {
  cursor?: string | null
  collections?: string[]
  batchSize?: number
}

export interface PullResponseBody {
  changes: ServerChange[]
  cursor: string | null
  hasMore: boolean
}

// WebSocket protocol
export interface WsRequestMessage {
  type: "push" | "pull"
  requestId: string
  payload: PushRequestBody | PullRequestBody
}

export interface WsResponseMessage {
  type: "push_result" | "pull_result" | "error"
  requestId: string
  payload: PushResponseBody | PullResponseBody | { message: string }
}

export interface WsServerPushMessage {
  type: "server_push"
  payload: ServerChange[]
}
