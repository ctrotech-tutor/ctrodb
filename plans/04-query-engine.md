# Plan 04 — Query Engine

## Overview

The query engine is the heart of ctrodb. It consists of three components:

1. **QueryBuilder** — The fluent API that developers interact with
2. **QueryPlanner** — Analyzes conditions and generates an optimized execution plan
3. **QueryExecutor** — Executes the plan against the storage adapter

## Condition Model

```
Query structure:
  [
    [condition, condition, ...],   // Group 0 (AND)
    [condition, condition, ...],   // Group 1 (OR — from orWhere)
  ]

  Each top-level array is joined by OR
  Each inner array is joined by AND
  
  Example: where('age', '>=', 18).where('status', 'active').orWhere(q => q.where('role', 'admin'))
  → [ [{age >= 18}, {status == active}], [{role == admin}] ]
  → (age >= 18 AND status == active) OR (role == admin)
```

```typescript
interface QueryCondition {
  type: 'where' | 'search';
  field: string;
  op?: '==' | '!=' | '>' | '<' | '>=' | '<=';
  value: any;
}

interface QueryPlan {
  strategy: 'index_scan' | 'full_scan' | 'id_lookup';
  indexName?: string;            // Name of the index to use (for index_scan)
  range?: IDBKeyRange;           // Key range for range queries
  primaryConditions: QueryCondition[];   // Conditions satisfied by the index
  postFilterConditions: QueryCondition[]; // Conditions to filter in memory
  sort?: SortSpec;
  limit?: number;
  offset?: number;
  groupType: 'single' | 'or';   // Single group or OR combination
  groups?: QueryPlan[];          // Sub-plans for each OR group
}

interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}
```

## Query Planner

The planner's job is to generate the most efficient execution plan:

```typescript
class QueryPlanner {
  plan(
    conditionGroups: QueryCondition[][],
    collectionSchema: CollectionSchema | null,
    indexes: IndexDefinition[]
  ): QueryPlan {
    if (conditionGroups.length === 0 || conditionGroups[0].length === 0) {
      return { strategy: 'full_scan', primaryConditions: [], postFilterConditions: [], groupType: 'single' };
    }

    if (conditionGroups.length === 1) {
      return this.planSingleGroup(conditionGroups[0], collectionSchema, indexes);
    }

    // OR query — plan each group independently, merge results
    return {
      strategy: 'full_scan', // OR always needs merging
      groupType: 'or',
      groups: conditionGroups.map(
        group => this.planSingleGroup(group, collectionSchema, indexes)
      ),
      primaryConditions: [],
      postFilterConditions: [],
      sort: undefined,
      limit: undefined,
      offset: undefined,
    };
  }

  private planSingleGroup(
    conditions: QueryCondition[],
    collectionSchema: CollectionSchema | null,
    indexes: IndexDefinition[]
  ): QueryPlan {
    const indexedConditions: QueryCondition[] = [];
    const nonIndexedConditions: QueryCondition[] = [];
    let searchCondition: QueryCondition | null = null;

    // Categorize conditions
    for (const condition of conditions) {
      if (condition.type === 'search') {
        searchCondition = condition;
        continue;
      }
      if (this.isFieldIndexed(condition.field, indexes)) {
        indexedConditions.push(condition);
      } else {
        nonIndexedConditions.push(condition);
      }
    }

    // If no indexed conditions and no search, full scan
    if (indexedConditions.length === 0 && !searchCondition) {
      return {
        strategy: 'full_scan',
        primaryConditions: [],
        postFilterConditions: conditions,
        groupType: 'single',
      };
    }

    // If FTS search, use FTS index first, then filter
    if (searchCondition) {
      return {
        strategy: 'full_scan', // FTS handles its own indexing within the plugin
        primaryConditions: [searchCondition],
        postFilterConditions: [...indexedConditions, ...nonIndexedConditions],
        groupType: 'single',
      };
    }

    // Pick the best indexed condition (most selective)
    const bestCondition = this.selectBestIndexedCondition(indexedConditions, indexes);
    const remainingConditions = indexedConditions
      .filter(c => c !== bestCondition)
      .concat(nonIndexedConditions);

    // Build key range if applicable
    let range: IDBKeyRange | undefined;
    if (['>', '<', '>=', '<='].includes(bestCondition.op!)) {
      range = this.createKeyRange(bestCondition.op!, bestCondition.value);
    }

    return {
      strategy: 'index_scan',
      indexName: bestCondition.field,
      range,
      primaryConditions: [bestCondition],
      postFilterConditions: remainingConditions,
      groupType: 'single',
    };
  }

  private isFieldIndexed(field: string, indexes: IndexDefinition[]): boolean {
    return indexes.some(idx => idx.field === field);
  }

  private selectBestIndexedCondition(
    conditions: QueryCondition[],
    indexes: IndexDefinition[]
  ): QueryCondition {
    // Preference: equality > range > inequality
    // Equality on unique index is best (returns 0 or 1 record)
    // Range on any index is next
    // Inequality (!=) is worst — can't use IDBKeyRange effectively
    
    const getPriority = (cond: QueryCondition): number => {
      const index = indexes.find(idx => idx.field === cond.field);
      if (cond.op === '==') return index?.unique ? 5 : 4;
      if (['>', '<', '>=', '<='].includes(cond.op!)) return 3;
      if (cond.op === '!=') return 1;
      return 0;
    };

    return conditions.reduce((best, current) =>
      getPriority(current) > getPriority(best) ? current : best
    );
  }

  private createKeyRange(op: string, value: any): IDBKeyRange {
    switch (op) {
      case '>':  return IDBKeyRange.lowerBound(value, true);  // exclusive
      case '>=': return IDBKeyRange.lowerBound(value);         // inclusive
      case '<':  return IDBKeyRange.upperBound(value, true);  // exclusive
      case '<=': return IDBKeyRange.upperBound(value);         // inclusive
      default: return null;
    }
  }
}
```

## Query Executor

The executor runs the plan against the adapter:

```typescript
class QueryExecutor {
  async execute<T>(
    adapter: StorageAdapter,
    collectionName: string,
    plan: QueryPlan,
    conditions: QueryCondition[][]  // original conditions for Model creation
  ): Promise<T[]> {
    if (plan.groupType === 'or') {
      return this.executeOrQuery(adapter, collectionName, plan);
    }

    let results: T[];

    switch (plan.strategy) {
      case 'index_scan':
        results = await adapter.scanIndex(
          collectionName,
          plan.indexName!,
          plan.range,
          plan.postFilterConditions
        );
        break;

      case 'full_scan':
        if (plan.primaryConditions.length > 0 && plan.primaryConditions[0].type === 'search') {
          // FTS search — handled by FTS plugin via adapter
          results = await adapter.ftsSearch(
            collectionName,
            plan.primaryConditions[0].field,
            plan.primaryConditions[0].value
          );
          // Apply post-filters
          results = this.applyFilters(results, plan.postFilterConditions);
        } else {
          results = await adapter.findAll(collectionName);
          results = this.applyFilters(results, [
            ...plan.primaryConditions,
            ...plan.postFilterConditions,
          ]);
        }
        break;

      case 'id_lookup':
        const idCondition = plan.primaryConditions[0];
        const record = await adapter.findById(collectionName, idCondition.value);
        results = record ? [record] : [];
        results = this.applyFilters(results, plan.postFilterConditions);
        break;
    }

    // Apply sort
    if (plan.sort) {
      results = this.applySort(results, plan.sort);
    }

    // Apply offset/limit
    if (plan.offset) {
      results = results.slice(plan.offset);
    }
    if (plan.limit) {
      results = results.slice(0, plan.limit);
    }

    return results;
  }

  private async executeOrQuery<T>(
    adapter: StorageAdapter,
    collectionName: string,
    plan: QueryPlan
  ): Promise<T[]> {
    const allResults = await Promise.all(
      plan.groups!.map(groupPlan =>
        this.execute(adapter, collectionName, groupPlan, [])
      )
    );

    // Merge unique results by ID
    const seen = new Set<ID>();
    const merged: T[] = [];
    for (const groupResults of allResults) {
      for (const record of groupResults) {
        if (!seen.has((record as any).id)) {
          seen.add((record as any).id);
          merged.push(record);
        }
      }
    }

    return merged;
  }

  private applyFilters<T>(records: T[], conditions: QueryCondition[]): T[] {
    if (conditions.length === 0) return records;
    return records.filter(record => {
      return conditions.every(cond => {
        if (cond.type === 'search') return true; // Already handled by FTS
        const recordValue = (record as any)[cond.field];
        switch (cond.op) {
          case '==': return recordValue === cond.value;
          case '!=': return recordValue !== cond.value;
          case '>':  return recordValue > cond.value;
          case '>=': return recordValue >= cond.value;
          case '<':  return recordValue < cond.value;
          case '<=': return recordValue <= cond.value;
          default: return false;
        }
      });
    });
  }

  private applySort<T>(records: T[], sort: SortSpec): T[] {
    return [...records].sort((a, b) => {
      const aVal = (a as any)[sort.field];
      const bVal = (b as any)[sort.field];
      if (aVal === bVal) return 0;
      const comparison = aVal < bVal ? -1 : 1;
      return sort.direction === 'desc' ? -comparison : comparison;
    });
  }
}
```

## QueryBuilder Implementation

```typescript
class QueryBuilder<T extends Record<string, any>> {
  private conditionGroups: QueryCondition[][] = [[]];
  private sortSpec: SortSpec | undefined;
  private limitValue: number | undefined;
  private offsetValue: number | undefined;
  private includeRelations: string[] = [];

  constructor(
    private collection: Collection<T>,
    private planner: QueryPlanner,
    private executor: QueryExecutor
  ) {}

  where(field: keyof T, opOrValue: any, value?: any): this {
    const supportedOps = ['==', '!=', '>', '<', '>=', '<='];
    let op: string;
    let val: any;

    if (value === undefined) {
      op = '==';
      val = opOrValue;
    } else {
      op = opOrValue;
      val = value;
    }

    if (!supportedOps.includes(op)) {
      throw new Error(`Unsupported operator '${op}'. Supported: ${supportedOps.join(', ')}`);
    }

    const lastGroup = this.conditionGroups[this.conditionGroups.length - 1];
    lastGroup.push({ type: 'where', field: field as string, op, value: val });
    return this;
  }

  orWhere(callback: (q: QueryBuilder<T>) => void): this {
    const childBuilder = new QueryBuilder(this.collection, this.planner, this.executor);
    callback(childBuilder);

    const newGroup = childBuilder.conditionGroups[0];
    if (newGroup.length > 0) {
      this.conditionGroups.push(newGroup);
    }
    return this;
  }

  sort(spec: Partial<Record<keyof T, 'asc' | 'desc'>>): this {
    const entries = Object.entries(spec);
    if (entries.length > 0) {
      const [field, direction] = entries[0];
      this.sortSpec = { field: field as string, direction: direction || 'asc' };
    }
    return this;
  }

  limit(n: number): this {
    this.limitValue = n;
    return this;
  }

  offset(n: number): this {
    this.offsetValue = n;
    return this;
  }

  async fetch(): Promise<(Model<T> & T)[]> {
    const collectionSchema = this.collection._getSchema();
    const indexes = collectionSchema?.indexes || [];

    const plan = this.planner.plan(this.conditionGroups, collectionSchema, indexes);
    plan.sort = this.sortSpec;
    plan.limit = this.limitValue;
    plan.offset = this.offsetValue;

    const rawRecords = await this.executor.execute<T>(
      this.collection._getAdapter(),
      this.collection.name,
      plan,
      this.conditionGroups
    );

    return this.collection._toModels(rawRecords);
  }

  async first(): Promise<(Model<T> & T) | undefined> {
    const results = await this.limit(1).fetch();
    return results[0];
  }

  async count(): Promise<number> {
    const results = await this.fetch();
    return results.length;
  }

  async toArray(): Promise<T[]> {
    const results = await this.fetch();
    return results.map(model => model.toJSON());
  }

  observe(callback: (results: (Model<T> & T)[]) => void): () => void {
    const observer = new QueryObserver(this, this.collection);
    return observer.subscribe(callback);
  }

  search(field: string, query: string): this {
    const lastGroup = this.conditionGroups[this.conditionGroups.length - 1];
    lastGroup.push({ type: 'search', field, value: query });
    return this;
  }

  include(...relations: string[]): this {
    this.includeRelations = relations;
    return this;
  }
}
```

## Performance Considerations

### Index Scan Strategy

When an index is available:
1. Use `index.getAll(range)` — this is O(log n + k) where k = results size
2. Apply post-filter conditions in JS on the reduced result set
3. This is much faster than full scan for selective queries

### Full Scan Strategy

When no index is available:
1. Use `objectStore.getAll()` to fetch all records
2. Apply all conditions in JS
3. Log a warning in development mode suggesting an index

### Sort Optimization

- If a sort field matches an index and that's the primary index scan, the results come pre-sorted from IDB
- Otherwise, sort in JS (this is usually fine for result sets up to thousands of records)

### Limit/Optimization

- `limit` + `offset` are applied after fetching results
- For large datasets, consider implementing cursor-based pagination in future versions
- The executor could short-circuit after finding `limit` records from an index scan

### Development Warnings

```typescript
// Warn when a full scan is performed
if (plan.strategy === 'full_scan' && conditions.length > 0) {
  console.warn(
    `[ctrodb] Query on "${collectionName}" with conditions`,
    conditions,
    `uses a full scan. Add indexes on these fields:`,
    conditions.filter(c => c.type === 'where').map(c => c.field)
  );
}

// Warn when sorting large result sets
if (plan.sort && results.length > 1000) {
  console.warn(
    `[ctrodb] Sorting ${results.length} records in memory. Consider adding an index on "${plan.sort.field}" for better performance.`
  );
}
```
