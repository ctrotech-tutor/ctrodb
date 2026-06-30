import { WebSocketServer, WebSocket } from "ws"
import type { Server } from "http"
import type { SyncStore } from "../store"
import type {
  WsRequestMessage,
  WsResponseMessage,
  WsServerPushMessage,
  PushRequestBody,
  PullRequestBody,
  ServerChange,
} from "../types"

// Track connected clients for broadcasting server pushes
let clients: Set<WebSocket> = new Set()

export function getClients(): Set<WebSocket> {
  return clients
}

export function broadcastChanges(changes: ServerChange[]): void {
  const message: WsServerPushMessage = {
    type: "server_push",
    payload: changes,
  }
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

function handleMessage(
  ws: WebSocket,
  raw: string,
  store: SyncStore,
): void {
  let msg: WsRequestMessage
  try {
    msg = JSON.parse(raw) as WsRequestMessage
  } catch {
    ws.send(
      JSON.stringify({
        type: "error",
        requestId: "unknown",
        payload: { message: "Invalid JSON" },
      } satisfies WsResponseMessage),
    )
    return
  }

  if (!msg.type || !msg.requestId) {
    ws.send(
      JSON.stringify({
        type: "error",
        requestId: msg.requestId ?? "unknown",
        payload: { message: "Missing type or requestId" },
      } satisfies WsResponseMessage),
    )
    return
  }

  switch (msg.type) {
    case "push": {
      const body = msg.payload as PushRequestBody
      const changes = body.changes ?? []
      const accepted: Array<{ id: string; serverTimestamp: string }> = []
      const conflicts: any[] = []
      const errors: Array<{ id: string; error: string }> = []

      for (const change of changes) {
        try {
          const local = store.getRecord(change.collection, change.recordId)

          if (change.type === "create" && local) {
            conflicts.push({
              changeId: change.id,
              recordId: change.recordId,
              collection: change.collection,
              local: change.data,
              remote: local,
              localTimestamp: change.timestamp,
              remoteTimestamp: (local._updatedAt as string) ?? new Date().toISOString(),
              fieldConflicts: Object.keys(change.data ?? {}).filter(
                (k) => k !== "id" && (change.data as any)[k] !== (local as any)[k],
              ),
            })
            continue
          }

          if (
            (change.type === "update" || change.type === "delete") &&
            local
          ) {
            const localUpdatedAt = local._updatedAt as string | undefined
            if (localUpdatedAt && localUpdatedAt > change.timestamp) {
              conflicts.push({
                changeId: change.id,
                recordId: change.recordId,
                collection: change.collection,
                local: change.data,
                remote: local,
                localTimestamp: change.timestamp,
                remoteTimestamp: localUpdatedAt,
                fieldConflicts: Object.keys(change.data ?? {}).filter(
                  (k) => k !== "id" && (change.data as any)[k] !== (local as any)[k],
                ),
              })
              continue
            }
          }

          const serverTimestamp = new Date().toISOString()

          if (change.type === "delete") {
            store.deleteRecord(change.collection, change.recordId)
            store.appendChange(change.collection, change.recordId, "delete", null)
          } else {
            const recordData = { ...(change.data ?? {}), _updatedAt: serverTimestamp }
            store.upsertRecord(change.collection, change.recordId, recordData)
            store.appendChange(
              change.collection,
              change.recordId,
              change.type,
              recordData,
            )
          }

          accepted.push({ id: change.id, serverTimestamp })
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error"
          errors.push({ id: change.id, error: message })
        }
      }

      ws.send(
        JSON.stringify({
          type: "push_result",
          requestId: msg.requestId,
          payload: { accepted, conflicts, errors },
        } satisfies WsResponseMessage),
      )
      break
    }

    case "pull": {
      const body = msg.payload as PullRequestBody
      const batchSize = Math.min(Math.max(1, body.batchSize ?? 100), 500)
      const result = store.getChanges(body.cursor ?? null, body.collections, batchSize)

      ws.send(
        JSON.stringify({
          type: "pull_result",
          requestId: msg.requestId,
          payload: { changes: result.changes, cursor: result.cursor, hasMore: result.hasMore },
        } satisfies WsResponseMessage),
      )
      break
    }

    default:
      ws.send(
        JSON.stringify({
          type: "error",
          requestId: msg.requestId,
          payload: { message: `Unknown message type: ${msg.type}` },
        } satisfies WsResponseMessage),
      )
  }
}

export function createWsServer(server: Server, store: SyncStore): WebSocketServer {
  const wss = new WebSocketServer({ server })

  wss.on("connection", (ws) => {
    clients.add(ws)

    ws.on("message", (raw) => {
      handleMessage(ws, raw.toString(), store)
    })

    ws.on("close", () => {
      clients.delete(ws)
    })

    ws.on("error", () => {
      clients.delete(ws)
    })
  })

  return wss
}
