import type { Request, Response } from "express"
import type { SyncStore } from "../store"
import type { PullRequestBody, PullResponseBody } from "../types"

const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 500

export function createPullHandler(store: SyncStore) {
  return (req: Request, res: Response): void => {
    const { cursor, collections, batchSize: rawBatchSize } = req.body as PullRequestBody

    const batchSize = Math.min(
      Math.max(1, rawBatchSize ?? DEFAULT_BATCH_SIZE),
      MAX_BATCH_SIZE,
    )

    const result = store.getChanges(cursor ?? null, collections, batchSize)

    const body: PullResponseBody = {
      changes: result.changes,
      cursor: result.cursor,
      hasMore: result.hasMore,
    }

    res.json(body)
  }
}
