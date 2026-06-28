# Issue 15: Schema Validation Runs After Plugin Hooks (Ordering Bug)

**Severity:** LOW
**File(s):** `src/collection.ts`
**Status:** Planned

## Problem

In `Collection.create()`:
1. `runHook("onBeforeCreate")` — validation plugin runs here
2. `schema.applyDefaults()`
3. `schema.validate()`

This means the validation plugin sees data before defaults are applied. If a user omits a field with a default value, the validation plugin sees `undefined` for that field, which is correct behavior for the general case. But the deeper issue is that `onBeforeCreate` should have the full picture (data after defaults) before making validation decisions.

## Fix Strategy

Swap the order in `create()`:
1. `schema.applyDefaults()`
2. `schema.validate()`
3. `runHook("onBeforeCreate")`

### Changes

1. **`src/collection.ts`** — In `create()`, reorder the steps. Apply defaults and run schema validation BEFORE plugin hooks fire.

### Key considerations

- Plugin hooks like `onBeforeCreate` can modify data, so we need to decide: should they see the data before or after defaults? The safest answer is **after** defaults — so the plugin sees the full record including defaulted values.
- If a plugin needs to see raw input before defaults, it can read original data from the event context (not currently available — future concern).
- The `onBeforeUpdate` path already follows the "after fetch existing" pattern and is less affected.

### Verification

- Optional string field with default, omitted in create → defaults applied before validation plugin sees data
- Existing plugin tests still pass after reordering
