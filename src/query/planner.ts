import type { CollectionSchema, IndexDefinition, QueryCondition, QueryPlan } from "../types"
import { createQueryRange, isQueryKey } from "./range"

export class QueryPlanner {
  plan(
    conditionGroups: QueryCondition[][],
    collectionSchema: CollectionSchema | null,
    indexes: IndexDefinition[],
  ): QueryPlan {
    if (conditionGroups.length === 0 || !conditionGroups[0] || conditionGroups[0].length === 0) {
      return {
        strategy: "full_scan",
        primaryConditions: [],
        postFilterConditions: [],
        groupType: "single",
      }
    }

    if (conditionGroups.length === 1 && conditionGroups[0]) {
      return this.#planSingleGroup(conditionGroups[0], collectionSchema, indexes)
    }

    return {
      strategy: "full_scan",
      groupType: "or",
      groups: conditionGroups.map((group) =>
        this.#planSingleGroup(group, collectionSchema, indexes),
      ),
      primaryConditions: [],
      postFilterConditions: [],
    }
  }

  #planSingleGroup(
    conditions: QueryCondition[],
    collectionSchema: CollectionSchema | null,
    indexes: IndexDefinition[],
  ): QueryPlan {
    const idEquality = conditions.find(
      (c) => c.field === "id" && c.op === "==" && isQueryKey(c.value),
    )
    if (idEquality) {
      const remaining = conditions.filter((c) => c !== idEquality)
      return {
        strategy: "id_lookup",
        primaryConditions: [idEquality],
        postFilterConditions: remaining,
        groupType: "single",
      }
    }

    const indexedConditions: QueryCondition[] = []
    const nonIndexedConditions: QueryCondition[] = []
    // `search` (substring) and `match` (tokenised) are applied by the executor
    // on the rows themselves, so they cannot drive an adapter key range. They
    // are carried, not dropped — previously every `search()` except the last
    // one disappeared from the plan, so chaining them silently widened results.
    const textualConditions: QueryCondition[] = []

    for (const condition of conditions) {
      if (condition.type === "search" || condition.type === "match") {
        textualConditions.push(condition)
        continue
      }
      if (this.#isFieldIndexed(condition.field, indexes)) {
        indexedConditions.push(condition)
      } else {
        nonIndexedConditions.push(condition)
      }
    }

    if (indexedConditions.length === 0 && textualConditions.length === 0) {
      return {
        strategy: "full_scan",
        primaryConditions: [],
        postFilterConditions: conditions,
        groupType: "single",
      }
    }

    if (textualConditions.length > 0) {
      return {
        strategy: "full_scan",
        primaryConditions: textualConditions,
        postFilterConditions: [...indexedConditions, ...nonIndexedConditions],
        groupType: "single",
      }
    }

    const bestCondition = this.#selectBestIndexedCondition(
      indexedConditions,
      indexes,
      collectionSchema,
    )

    // A condition may only drive an index scan when the adapter can express it
    // as a contiguous key range. `!=`, booleans, null, objects and arrays can
    // not: they fall back to a full scan so results are always correct.
    const range = createQueryRange(bestCondition.op ?? "==", bestCondition.value)

    if (!range) {
      return {
        strategy: "full_scan",
        primaryConditions: [],
        postFilterConditions: conditions,
        groupType: "single",
      }
    }

    const remainingConditions = indexedConditions
      .filter((c) => c !== bestCondition)
      .concat(nonIndexedConditions)

    return {
      strategy: "index_scan",
      indexName: bestCondition.field,
      range,
      primaryConditions: [bestCondition],
      postFilterConditions: remainingConditions,
      groupType: "single",
    }
  }

  #isFieldIndexed(field: string, indexes: IndexDefinition[]): boolean {
    return indexes.some((idx) => idx.field === field)
  }

  #selectBestIndexedCondition(
    conditions: QueryCondition[],
    indexes: IndexDefinition[],
    collectionSchema: CollectionSchema | null,
  ): QueryCondition {
    const fieldType = (field: string): string | undefined => collectionSchema?.fields[field]?.type

    const isIndexable = (cond: QueryCondition): boolean => {
      const type = fieldType(cond.field)
      // Booleans and structured values are not valid IndexedDB keys.
      if (type === "boolean" || type === "object" || type === "array") return false
      return isQueryKey(cond.value)
    }

    const getPriority = (cond: QueryCondition): number => {
      if (!isIndexable(cond)) return 0
      const index = indexes.find((idx) => idx.field === cond.field)
      if (cond.op === "==") return index?.unique ? 5 : 4
      if (cond.op && [">", "<", ">=", "<="].includes(cond.op)) return 3
      return 1
    }

    return conditions.reduce((best, current) =>
      getPriority(current) > getPriority(best) ? current : best,
    )
  }
}
