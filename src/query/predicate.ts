/**
 * One implementation of "does this record match this condition?".
 *
 * It used to exist three times: in the executor (with `search` support and
 * `false` for unknown operators) and in both adapters (without `search`, and
 * `true` — i.e. "match" — for unknown operators). Adapter post-filters and the
 * executor therefore disagreed about untested inputs, and any new operator had
 * to be added in three places or silently behave differently per backend
 * (audit L-08).
 */
import type { QueryCondition } from "../types"
import { tokenize } from "./tokenizer"

/**
 * Evaluate a single `where` condition. `search` conditions are handled by
 * {@link matchesSearch} so that adapters can skip them explicitly.
 */
export function matchesWhere(record: Record<string, unknown>, cond: QueryCondition): boolean {
  const value = record[cond.field]

  switch (cond.op) {
    case "==":
      return value === cond.value
    case "!=":
      return value !== cond.value
    case ">":
      return (value as number) > (cond.value as number)
    case ">=":
      return (value as number) >= (cond.value as number)
    case "<":
      return (value as number) < (cond.value as number)
    case "<=":
      return (value as number) <= (cond.value as number)
    // An operator the planner did not understand must not match: returning
    // `true` would silently widen a result set.
    default:
      return false
  }
}

/**
 * `search` is a case-insensitive substring match on one field (documented
 * behaviour, audit M-15 — it is not the FTS index).
 */
export function matchesSearch(record: Record<string, unknown>, cond: QueryCondition): boolean {
  const value = record[cond.field]
  if (typeof value !== "string" || typeof cond.value !== "string") return false
  return value.toLowerCase().includes(cond.value.toLowerCase())
}

/**
 * Tokenised **AND** match across `cond.fields` (or `cond.field` when unset).
 *
 * This is what `query().match()` means, and it is deliberately different from
 * `search()`: every token of the query must appear as a whole word somewhere in
 * the selected fields. The full-text index produces *candidates* for exactly
 * this predicate, and this function is what decides membership — so a stale or
 * over-broad index can never widen a result set.
 */
export function matchesMatch(record: Record<string, unknown>, cond: QueryCondition): boolean {
  if (typeof cond.value !== "string") return false

  const tokens = tokenize(cond.value)
  // A query with no searchable tokens matches nothing: the index would return
  // no postings either, and matching everything would be a surprise.
  if (tokens.length === 0) return false

  const fields = cond.fields ?? [cond.field]
  const haystack = new Set<string>()
  for (const field of fields) {
    const value = record[field]
    if (typeof value !== "string") continue
    for (const token of tokenize(value)) haystack.add(token)
  }

  return tokens.every((token) => haystack.has(token))
}

export function matchesCondition(record: Record<string, unknown>, cond: QueryCondition): boolean {
  if (cond.type === "search") return matchesSearch(record, cond)
  if (cond.type === "match") return matchesMatch(record, cond)
  return matchesWhere(record, cond)
}

/**
 * `conditions.every(...)`, in one place.
 *
 * @param includeSearch adapters pass `false`: the executor applies `search`
 *   conditions itself after collecting candidates.
 */
export function matchesAll(
  record: Record<string, unknown>,
  conditions: QueryCondition[],
  includeSearch = true,
): boolean {
  for (const cond of conditions) {
    if (!includeSearch && cond.type === "search") continue
    if (!matchesCondition(record, cond)) return false
  }
  return true
}
