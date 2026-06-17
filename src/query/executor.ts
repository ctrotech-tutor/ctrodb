import type { ID, QueryCondition, QueryPlan, SortSpec, StorageAdapter } from "../types"

export class QueryExecutor {
  async execute<T extends Record<string, unknown>>(
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

    if (plan.sort) {
      results = this.#applySort(results, plan.sort)
    }
    if (plan.offset) {
      results = results.slice(plan.offset)
    }
    if (plan.limit !== undefined) {
      results = results.slice(0, plan.limit)
    }

    return results
  }

  async #executeOrQuery<T extends Record<string, unknown>>(
    adapter: StorageAdapter,
    collectionName: string,
    plan: QueryPlan,
  ): Promise<T[]> {
    const groups = plan.groups
    if (!groups) throw new Error("Query plan: OR query requires groups")
    const allResults = await Promise.all(
      groups.map((groupPlan) => this.execute<T>(adapter, collectionName, groupPlan)),
    )

    const seen = new Set<ID>()
    const merged: T[] = []
    for (const groupResults of allResults) {
      for (const record of groupResults) {
        const id = record.id as ID
        if (!seen.has(id)) {
          seen.add(id)
          merged.push(record)
        }
      }
    }

    return merged
  }

  #applyFilters<T extends Record<string, unknown>>(
    records: T[],
    conditions: QueryCondition[],
  ): T[] {
    if (conditions.length === 0) return records
    return records.filter((record) =>
      conditions.every((cond) => {
        if (cond.type === "search") {
          const recordValue = record[cond.field]
          if (typeof recordValue === "string" && typeof cond.value === "string") {
            return recordValue.toLowerCase().includes(cond.value.toLowerCase())
          }
          return false
        }
        const recordValue = record[cond.field] as unknown
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

  #applySort<T extends Record<string, unknown>>(records: T[], sort: SortSpec): T[] {
    return [...records].sort((a, b) => {
      const aVal = a[sort.field] as number | string
      const bVal = b[sort.field] as number | string
      if (aVal === bVal) return 0
      const comparison = aVal < bVal ? -1 : 1
      return sort.direction === "desc" ? -comparison : comparison
    })
  }
}
