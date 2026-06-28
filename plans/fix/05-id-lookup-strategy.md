# Issue 13: QueryPlanner Never Generates `id_lookup` Strategy

**Severity:** LOW
**File(s):** `src/query/planner.ts`
**Status:** Planned

## Problem

The `id_lookup` strategy is defined in `types.ts:51` and handled in `executor.ts:44-51` (calls `adapter.findById()` which is the most efficient path). But `QueryPlanner.#planSingleGroup()` never emits this strategy. Conditions like `q.where("id", "==", someId)` are treated as `index_scan` (if `id` is indexed) or `full_scan`.

This means `useDoc` (which uses `.where("id", id)`) does a full scan on unindexed collections instead of the optimized `findById` path.

## Fix Strategy

Add an early check in `#planSingleGroup()`: if there's exactly one condition with `field === "id"` and `op === "=="`, return `id_lookup`.

### Changes

1. **`src/query/planner.ts`** — In `#planSingleGroup`, after categorizing conditions but before index analysis, check for a single `id == X` condition:

   ```typescript
   #planSingleGroup(conditions, collectionSchema, indexes): QueryPlan {
     // ...existing type search handling...

     // Check for id lookup — most efficient path
     if (conditions.length === 1) {
       const cond = conditions[0]
       if (cond && cond.field === "id" && cond.op === "==") {
         return {
           strategy: "id_lookup",
           primaryConditions: [cond],
           postFilterConditions: [],
           groupType: "single",
         }
       }
     }

     // ...rest of existing logic...
   }
   ```

2. **No changes to executor.ts** — it already handles `id_lookup` correctly.

### Key considerations

- Only emit `id_lookup` for a single `id == X` condition. Multiple conditions OR non-equality operators should still use index/full scan.
- The `id` field is automatically the keyPath in IndexedDB, so it's always "indexed" in the storage layer.
- No backward-compat concern — this only changes which code path is taken, not the result.

### Verification

- `q.where("id", "==", someId).fetch()` → executor uses `adapter.findById()` (confirmed via test mock/spy)
- `q.where("id", "==", someId).where("done", true).fetch()` → uses index_scan or full_scan (not id_lookup, since there are multiple conditions)
- `q.where("id", ">", someId).fetch()` → uses index_scan (not id_lookup, since op is not "==")
- Query results are identical regardless of strategy
