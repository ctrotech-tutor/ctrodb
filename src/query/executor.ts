import type { ID, QueryCondition, QueryPlan, SortSpec, StorageAdapter } from "../types"
import { compareQueryKeys } from "./range"

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
  ): Promise<T[]> {
    const results = await this.#executePlan<T>(adapter, collectionName, plan)

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
  ): Promise<T[]> {
    if (plan.groupType === "or") {
      return this.#executeOrQuery<T>(adapter, collectionName, plan)
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
  ): Promise<T[]> {
    const groups = plan.groups
    if (!groups) throw new Error("Query plan: OR query requires groups")
    // Group plans carry no window of their own; sorting/limit are applied once
    // to the merged result, otherwise an OR query silently ignored orderBy()
    // and limit() entirely.
    const allResults = await Promise.all(
      groups.map((groupPlan) => this.#executePlan<T>(adapter, collectionName, groupPlan)),
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

  #applyFilters<T extends object>(records: T[], conditions: QueryCondition[]): T[] {
    if (conditions.length === 0) return records
    return records.filter((record) =>
      conditions.every((cond) => {
        if (cond.type === "search") {
          const recordValue = (record as Record<string, unknown>)[cond.field]
          if (typeof recordValue === "string" && typeof cond.value === "string") {
            return recordValue.toLowerCase().includes(cond.value.toLowerCase())
          }
          return false
        }
        const recordValue = (record as Record<string, unknown>)[cond.field] as unknown
        switch (cond.op) {
          case "==":
            return recordValue === cond.value
          case "!=":
            return recordValue !== cond.value
          case ">":
            return (recordValue as number) > (cond.value as number)
          case ">=":
            return (recordValue as number) >= (cond.value as number)
          case "<":
            return (recordValue as number) < (cond.value as number)
          case "<=":
            return (recordValue as number) <= (cond.value as number)
          default:
            return false
        }
      }),
    )
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
