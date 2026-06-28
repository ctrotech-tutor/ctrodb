# Issue 12: IndexedDB `autoIncrement` vs String IDs

**Severity:** MEDIUM
**File(s):** `src/adapter/idb.ts`, `src/adapter/memory.ts`
**Status:** Planned

## Problem

Object stores are created with `autoIncrement: true`. When a record is created without an `id` field, IndexedDB auto-generates a number. When a record IS created with an `id` (e.g., nanoid), that value is used. This leads to mixed `string | number` IDs in the same collection.

`ID = number | string` in types.ts, but downstream code often assumes `string` IDs.

## Fix Strategy

Remove `autoIncrement: true` from IndexedDB adapter. Require explicit `id` field at the adapter level.

### Changes

1. **`src/adapter/idb.ts`** — Change `autoIncrement: true` to `autoIncrement: false`. Update `idbCreate` to throw if `data.id` is missing.

2. **`src/adapter/memory.ts`** — Remove the counter fallback logic. If no `id` is provided in `create()`, throw an error instead of auto-generating a number.

3. **`src/collection.ts`** — The `create()` method in collection already passes the data through as-is. If the user doesn't provide an id, neither the schema nor the collection auto-generates one. Update `applyDefaults()` or add a pre-step that generates an ID if missing — using `crypto.randomUUID()` or a simple ID generator built into the library.

### Key considerations

- This is a **breaking change** — existing auto-increment users will need to provide IDs.
- The library should auto-generate a string ID if none is provided, so the DX of `create({ title: "foo" })` still works.
- Use `crypto.randomUUID()` which is available in modern browsers and Node.js 20+ (our minimum target).
- The auto-generated ID should be a string (UUID), not a number.
- `MemoryAdapter` needs to align: no more counter-based IDs.

### Verification

- `create({ title: "foo" })` → auto-generates string UUID, stored correctly
- `create({ id: "my-custom-id", title: "foo" })` → uses provided ID
- `create({ id: 123, title: "foo" })` → uses provided numeric ID (still allowed since `ID = number | string`)
- All records in a collection have consistent types
- Tests that relied on auto-increment numbers updated to either provide IDs or expect UUIDs
