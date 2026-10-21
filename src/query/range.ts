import type { QueryKey, QueryOperator, QueryRange } from "../types"

/**
 * Storage-neutral key ranges.
 *
 * The query planner and the sync engine describe ranges with plain objects so
 * they never depend on the browser `IDBKeyRange` constructor. `IndexedDBAdapter`
 * converts the descriptor to a real `IDBKeyRange`; `MemoryAdapter` evaluates it
 * directly.
 */

/** True for values that IndexedDB can use as a key and that we can order. */
export function isQueryKey(value: unknown): value is QueryKey {
  if (typeof value === "string") return true
  if (typeof value === "number") return !Number.isNaN(value)
  return value instanceof Date && !Number.isNaN(value.getTime())
}

// IndexedDB orders numbers before dates before strings. Reproducing that
// ordering keeps memory scans consistent with the IndexedDB adapter when data
// happens to mix key types (which schema validation normally prevents).
function typeRank(value: QueryKey): number {
  if (typeof value === "number") return 0
  if (value instanceof Date) return 1
  return 2
}

function primitiveValue(value: QueryKey): number | string {
  return value instanceof Date ? value.getTime() : value
}

/** Compare two index keys using IndexedDB's ordering rules. */
export function compareQueryKeys(a: QueryKey, b: QueryKey): number {
  const rankA = typeRank(a)
  const rankB = typeRank(b)
  if (rankA !== rankB) return rankA - rankB

  const left = primitiveValue(a)
  const right = primitiveValue(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Translate a comparison operator into a contiguous key range.
 *
 * Returns `undefined` for `"!="` (which is not contiguous) and for values that
 * cannot be used as an index key — callers must then fall back to a scan plus
 * post-filtering.
 */
export function createQueryRange(op: QueryOperator, value: unknown): QueryRange | undefined {
  if (!isQueryKey(value)) return undefined

  switch (op) {
    case "==":
      return { lower: value, upper: value, lowerOpen: false, upperOpen: false }
    case ">":
      return { lower: value, lowerOpen: true, upperOpen: false }
    case ">=":
      return { lower: value, lowerOpen: false, upperOpen: false }
    case "<":
      return { lowerOpen: false, upper: value, upperOpen: true }
    case "<=":
      return { lowerOpen: false, upper: value, upperOpen: false }
    default:
      return undefined
  }
}

/** A range that matches a single value (used for status lookups). */
export function equalityRange(value: QueryKey): QueryRange {
  return { lower: value, upper: value, lowerOpen: false, upperOpen: false }
}

/** Evaluate a descriptor against a stored field value. */
export function queryRangeContains(range: QueryRange, value: unknown): boolean {
  if (!isQueryKey(value)) return false

  const { lower, upper, lowerOpen, upperOpen } = range

  if (lower === undefined && upper === undefined) return true

  if (lower !== undefined && isQueryKey(lower)) {
    const compared = compareQueryKeys(value, lower)
    if (compared < 0 || (compared === 0 && lowerOpen)) return false
  }

  if (upper !== undefined && isQueryKey(upper)) {
    const compared = compareQueryKeys(value, upper)
    if (compared > 0 || (compared === 0 && upperOpen)) return false
  }

  return true
}
