import type { Request, Response } from "express"
import type { SyncStore } from "../store"
import type {
  PushRequestBody,
  PushResponseBody,
  SyncConflict,
} from "../types"

// Track which collections exist on the server for conflict detection
function detectFieldConflicts(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): string[] {
  return Object.keys(local).filter(
    (key) => key !== "id" && local[key] !== remote[key],
  )
}

export function createPushHandler(store: SyncStore) {
  return (req: Request, res: Response): void => {
    const { changes } = req.body as PushRequestBody

    if (!Array.isArray(changes) || changes.length === 0) {
      res.status(400).json({
        accepted: [],
        conflicts: [],
        errors: [{ id: "n/a", error: "Request body must contain a non-empty changes array" }],
      } satisfies PushResponseBody)
      return
    }

    const accepted: PushResponseBody["accepted"] = []
    const conflicts: SyncConflict[] = []
    const errors: PushResponseBody["errors"] = []

    for (const change of changes) {
      try {
        if (!change.id || !change.collection || !change.type) {
          errors.push({ id: change.id ?? "unknown", error: "Missing required fields: id, collection, type" })
          continue
        }

        const local = store.getRecord(change.collection, change.recordId)

        if (change.type === "create") {
          if (local) {
            conflicts.push({
              changeId: change.id,
              recordId: change.recordId,
              collection: change.collection,
              local: change.data,
              remote: local,
              localTimestamp: change.timestamp,
              remoteTimestamp: local._updatedAt as string ?? new Date().toISOString(),
              fieldConflicts: detectFieldConflicts(
                (change.data ?? {}) as Record<string, unknown>,
                local,
              ),
            })
            continue
          }
        }

        if (change.type === "update" || change.type === "delete") {
          if (local) {
            const localUpdatedAt = (local._updatedAt as string | undefined)
            if (localUpdatedAt && localUpdatedAt > change.timestamp) {
              conflicts.push({
                changeId: change.id,
                recordId: change.recordId,
                collection: change.collection,
                local: change.data,
                remote: local,
                localTimestamp: change.timestamp,
                remoteTimestamp: localUpdatedAt,
                fieldConflicts: detectFieldConflicts(
                  (change.data ?? {}) as Record<string, unknown>,
                  local,
                ),
              })
              continue
            }
          }
        }

        // Accept the change
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
            change.type === "delete" ? null : recordData,
          )
        }

        accepted.push({ id: change.id, serverTimestamp })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error"
        errors.push({ id: change.id, error: message })
      }
    }

    const body: PushResponseBody = { accepted, conflicts, errors }
    res.json(body)
  }
}
