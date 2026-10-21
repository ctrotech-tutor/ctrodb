import type { ID } from "../types"

/**
 * Generate a record id.
 *
 * `crypto.randomUUID()` where the runtime offers it (browsers, Node 19+, workers)
 * so ids are collision-safe across tabs; a time-prefixed random string otherwise,
 * which keeps ids roughly sortable by insertion time on older runtimes.
 */
export function generateId(): ID {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
