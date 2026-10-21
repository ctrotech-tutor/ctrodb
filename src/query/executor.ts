import type { ID, QueryCondition, QueryPlan, SortSpec, StorageAdapter } from "../types"
import { matchesAll } from "./predicate"
import { compareQueryKeys } from "./range"

/**
 * Resolve a tokenised query to candidate ids, when the database has a token
 * index for the collection (the full-text plugin supplies this).
 */
export type TokenSearch = (
  collection: string,
  query: string,
  fields?: string[],
) => Promise<ID[] | undefined>

export class QueryExecutor {
  /**
   * Execute a query plan.
   *
   * Ordering contract: without an explicit `orderBy`, results are returned in
   * **primary-key ascending** order on every adapter. Before this, memory
   * returned insertion order while IndexedDB returned key order, so
   * `limit()` without `orderBy()` produced different pages depending on the
   * backend (audit H-08).
   */
  async execute<T extends object>(
    adapter: StorageAdapter,
    collectionName: string,
    plan: QueryPlan,
    tokenSearch?: TokenSearch,
  ): Promise<T[]> {
    const results = await this.#executePlan<T>(adapter, collectionName, plan, tokenSearch)

    return this.#applyWindow(results, plan)
  }

  /** Sort/offset/limit, applied once, at the top of the plan tree. */
  #applyWindow<T extends object>(results: T[], plan: QueryPlan): T[] {
    let windowed = plan.sort
      ? this.#applySort(results, plan.sort)
      : this.#applyDefaultOrder(results)

    if (plan.offset) {
      windowed = windowed.slice(plan.offset)
    }
    if (plan.limit !== undefined) {
      windowed = windowed.slice(0, plan.limit)
    }
    return windowed
  }

  async #executePlan<T extends object>(
    adapter: StorageAdapter,
    collectionName: string,
    plan: QueryPlan,
    tokenSearch?: TokenSearch,
  ): Promise<T[]> {
    if (plan.groupType === "or") {
      return this.#executeOrQuery<T>(adapter, collectionName, plan, tokenSearch)
    }

    const matches = [...plan.primaryConditions, ...plan.postFilterConditions].filter(
      (condition) => condition.type === "match",
    )
    if (matches.length > 0) {
      return this.#executeMatch<T>(adapter, collectionName, plan, matches, tokenSearch)
    }

    let results: T[]

    switch (plan.strategy) {
      case "index_scan": {
        if (!plan.indexName) throw new Error("Query plan: index_scan requires indexName")
        results = (await adapter.scanIndex(
          collectionName,
          plan.indexName,
          plan.range,
          plan.postFilterConditions,
        )) as T[]
        break
      }

      case "full_scan": {
        if (plan.primaryConditions.length > 0 && plan.primaryConditions[0]?.type === "search") {
          results = (await adapter.findAll(collectionName)) as T[]
          results = this.#applyFilters(results, [
            ...plan.primaryConditions,
            ...plan.postFilterConditions,
          ])
        } else {
          results = (await adapter.findAll(collectionName)) as T[]
          results = this.#applyFilters(results, [
            ...plan.primaryConditions,
            ...plan.postFilterConditions,
          ])
        }
        break
      }

      case "id_lookup": {
        const idCondition = plan.primaryConditions[0]
        if (!idCondition) throw new Error("Query plan: id_lookup requires a primary condition")
        const record = (await adapter.findById(collectionName, idCondition.value as ID)) as T | null
        results = record ? [record] : []
        results = this.#applyFilters(results, plan.postFilterConditions)
        break
      }
    }

    return results
  }

  async #executeOrQuery<T extends object>(
    adapter: StorageAdapter,
    collectionName: string,
    plan: QueryPlan,
    tokenSearch?: TokenSearch,
  ): Promise<T[]> {
    const groups = plan.groups
    if (!groups) throw new Error("Query plan: OR query requires groups")
    // Group plans carry no window of their own; sorting/limit are applied once
    // to the merged result, otherwise an OR query silently ignored orderBy()
    // and limit() entirely.
    const allResults = await Promise.all(
      groups.map((groupPlan) =>
        this.#executePlan<T>(adapter, collectionName, groupPlan, tokenSearch),
      ),
    )

    const seen = new Set<ID>()
    const merged: T[] = []
    for (const groupResults of allResults) {
      for (const record of groupResults) {
        const id = (record as Record<string, unknown>).id as ID
        if (!seen.has(id)) {
          seen.add(id)
          merged.push(record)
        }
      }
    }

    return merged
  }

  /**
   * Execute a plan that contains `match` conditions.
   *
   * A token index turns the query into a bounded candidate set (one lookup per
   * query token, intersected), so only the matching rows are read. Without one
   * — no plugin, or an adapter that cannot index — the same predicate runs over
   * a full scan, which is why the **results are identical either way**: the
   * index only narrows what the predicate is asked to look at.
   */
  async #executeMatch<T extends object>(
    adapter: StorageAdapter,
    collectionName: string,
    plan: QueryPlan,
    matches: QueryCondition[],
    tokenSearch?: TokenSearch,
  ): Promise<T[]> {
    const conditions = [...plan.primaryConditions, ...plan.postFilterConditions].filter(
      (condition) => condition.type !== "match",
    )

    let candidates: T[]

    const ids = tokenSearch
      ? await this.#intersectTokenSearches(tokenSearch, collectionName, matches)
      : null
    if (ids) {
      candidates = await this.#readByIds<T>(adapter, collectionName, ids)
    } else {
      candidates = (await adapter.findAll(collectionName)) as T[]
    }

    // The predicate — not the index — decides membership.
    return this.#applyFilters(candidates, [...matches, ...conditions])
  }

  /**
   * Ids matching **every** `match` condition, or `null` when the token index
   * cannot answer (then the caller scans).
   */
  async #intersectTokenSearches(
    tokenSearch: TokenSearch,
    collectionName: string,
    matches: QueryCondition[],
  ): Promise<ID[] | null> {
    const sets = await Promise.all(
      matches.map((condition) =>
        tokenSearch(collectionName, String(condition.value), condition.fields),
      ),
    )

    // Any condition the index cannot answer sends the whole query to the scan
    // path: intersecting a partial answer would silently drop rows.
    if (sets.some((ids) => ids === undefined)) return null

    const [first, ...rest] = sets as ID[][]
    if (!first) return null

    const intersection = new Set(first)
    for (const ids of rest) {
      const keep = new Set(ids)
      for (const id of intersection) {
        if (!keep.has(id)) intersection.delete(id)
      }
    }
    return [...intersection]
  }

  /** Read a specific set of ids, one bulk call when the adapter offers it. */
  async #readByIds<T extends object>(
    adapter: StorageAdapter,
    collectionName: string,
    ids: ID[],
  ): Promise<T[]> {
    if (ids.length === 0) return []

    if (adapter.findByIds) {
      const records = await adapter.findByIds(collectionName, ids)
      return records.filter(
        (record): record is Record<string, unknown> => record !== undefined,
      ) as T[]
    }

    const records = await Promise.all(ids.map((id) => adapter.findById(collectionName, id)))
    return records.filter(
      (record): record is Record<string, unknown> => record !== undefined,
    ) as T[]
  }

  #applyFilters<T extends object>(records: T[], conditions: QueryCondition[]): T[] {
    if (conditions.length === 0) return records
    return records.filter((record) => matchesAll(record as Record<string, unknown>, conditions))
  }

  /**
   * Primary-key ascending, matching IndexedDB's natural key order.
   *
   * Already-ordered input (the common IndexedDB case) is returned as-is after a
   * single linear check, so this costs O(n) rather than O(n log n) there.
   */
  #applyDefaultOrder<T extends object>(records: T[]): T[] {
    let ordered = true
    for (let i = 1; i < records.length; i++) {
      const previous = (records[i - 1] as Record<string, unknown> | undefined)?.id as ID | undefined
      const current = (records[i] as Record<string, unknown> | undefined)?.id as ID | undefined
      if (previous === undefined || current === undefined) continue
      if (compareQueryKeys(previous, current) > 0) {
        ordered = false
        break
      }
    }
    if (ordered) return records

    return [...records].sort((a, b) => {
      const aId = (a as Record<string, unknown>).id as ID | undefined
      const bId = (b as Record<string, unknown>).id as ID | undefined
      if (aId === undefined || bId === undefined) return 0
      return compareQueryKeys(aId, bId)
    })
  }

  #applySort<T extends object>(records: T[], sort: SortSpec): T[] {
    return [...records].sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[sort.field] as number | string
      const bVal = (b as Record<string, unknown>)[sort.field] as number | string
      if (aVal === bVal) return 0
      const comparison = aVal < bVal ? -1 : 1
      return sort.direction === "desc" ? -comparison : comparison
    })
  }
}
