import type { CollectionSchema, IndexDefinition, QueryCondition, QueryPlan } from "../types"

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
    _collectionSchema: CollectionSchema | null,
    indexes: IndexDefinition[],
  ): QueryPlan {
    const idEquality = conditions.find((c) => c.field === "id" && c.op === "==")
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
    let searchCondition: QueryCondition | null = null

    for (const condition of conditions) {
      if (condition.type === "search") {
        searchCondition = condition
        continue
      }
      if (this.#isFieldIndexed(condition.field, indexes)) {
        indexedConditions.push(condition)
      } else {
        nonIndexedConditions.push(condition)
      }
    }

    if (indexedConditions.length === 0 && !searchCondition) {
      return {
        strategy: "full_scan",
        primaryConditions: [],
        postFilterConditions: conditions,
        groupType: "single",
      }
    }

    if (searchCondition) {
      return {
        strategy: "full_scan",
        primaryConditions: [searchCondition],
        postFilterConditions: [...indexedConditions, ...nonIndexedConditions],
        groupType: "single",
      }
    }

    const bestCondition = this.#selectBestIndexedCondition(indexedConditions, indexes)
    const remainingConditions = indexedConditions
      .filter((c) => c !== bestCondition)
      .concat(nonIndexedConditions)

    let range: IDBKeyRange | undefined
    if (bestCondition.op) {
      range = this.#createKeyRange(bestCondition.op, bestCondition.value)
    }

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
  ): QueryCondition {
    const getPriority = (cond: QueryCondition): number => {
      const index = indexes.find((idx) => idx.field === cond.field)
      if (cond.op === "==") return index?.unique ? 5 : 4
      if (cond.op && [">", "<", ">=", "<="].includes(cond.op)) return 3
      if (cond.op === "!=") return 1
      return 0
    }

    return conditions.reduce((best, current) =>
      getPriority(current) > getPriority(best) ? current : best,
    )
  }

  #createKeyRange(op: string, value: unknown): IDBKeyRange | undefined {
    if (value === undefined) return undefined
    switch (op) {
      case "==":
        return IDBKeyRange.only(value as IDBValidKey)
      case ">":
        return IDBKeyRange.lowerBound(value as IDBValidKey, true)
      case ">=":
        return IDBKeyRange.lowerBound(value as IDBValidKey)
      case "<":
        return IDBKeyRange.upperBound(value as IDBValidKey, true)
      case "<=":
        return IDBKeyRange.upperBound(value as IDBValidKey)
      default:
        return undefined
    }
  }
}
