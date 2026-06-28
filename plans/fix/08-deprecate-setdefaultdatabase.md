# Issue 14: `setDefaultDatabase` + `DatabaseProvider` Dual API

**Severity:** LOW
**File(s):** `src/react.ts`
**Status:** Planned

## Problem

Two ways to provide the database instance:
1. `setDefaultDatabase(db)` — sets a global module-level variable
2. `<DatabaseProvider db={db}>` — React context provider

The provider ALSO calls `setDefaultDatabase()` internally, meaning the global is always set. This creates confusing behavior where:
- Either API works in isolation
- Using both simultaneously has implicit shadowing behavior
- Testing with multiple DB instances is fragile (the global persists across tests)

## Fix Strategy

Make `DatabaseProvider` the only way to provide the DB instance. Remove the global fallback.

### Changes

1. **`src/react.ts`** — Remove `defaultDb` variable and `setDefaultDatabase()` function. `useDatabase()` only reads from React context.
2. **`src/react.ts`** — `DatabaseProvider` no longer calls `setDefaultDatabase()` — it just sets the context value.
3. **Export deprecation** — Keep `setDefaultDatabase` as a no-op export with a deprecation warning for one minor version, then remove.

### Key considerations

- This is a breaking change for users who use `setDefaultDatabase()` in non-React code or as a convenience for script-tag usage.
- For CDN/script-tag users, we expose a different mechanism (the global `CtroDB` namespace has its own initialization).
- The React tests need updating if they rely on `setDefaultDatabase()`.
- Simpler mental model: "Wrap your app in DatabaseProvider. That's it."

### Verification

- `<DatabaseProvider db={db}>` → `useDatabase()` returns `db`
- No `DatabaseProvider` → `useDatabase()` throws a clear error
- `setDefaultDatabase()` called but no provider → `useDatabase()` throws (no global fallback)
- Tests updated to use `DatabaseProvider` wrapper
