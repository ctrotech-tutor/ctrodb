# Issue 17: RelationsPlugin Monkey-Patches Collection via Proxy

**Severity:** LOW
**File(s):** `src/plugins/relations/index.ts`, `src/query/builder.ts`
**Status:** Planned

## Problem

The `relationsPlugin` wraps `db.collection` with a Proxy that intercepts calls and adds a `.with()` method. The `.with()` method then patches `QueryBuilder.fetch()` by wrapping it. This is fragile:
- If `db.collection` is called before the plugin initializes, patching doesn't apply
- If another plugin also patches `fetch()`, they conflict
- The Proxy modifies core library behavior from a plugin, violating encapsulation

## Fix Strategy

Move `.with()` to a first-class method on `QueryBuilder` or `Collection`, gated behind a feature flag or always available.

### Changes

1. **`src/query/builder.ts`** — Add a `.with(...relations: string[])` method to `QueryBuilder` that:
   - Stores the relation names to eager-load
   - On `fetch()`, after getting results, calls eager load on the models
   - Requires a reference to the relations engine (passed via constructor or fetched from plugins)

2. **`src/plugins/relations/index.ts`** — Remove the Proxy patching. Instead, the `relationsPlugin` registers its `RelationsEngine` so that `QueryBuilder.with()` can access it. One approach: the plugin adds itself to a registry on the Database instance that `QueryBuilder` can check during fetch.

3. **Alternative simpler approach** — Move `.with()` to `Collection` instead of `QueryBuilder`:

   ```typescript
   const posts = await db.collection("posts").with("author", "comments").fetch()
   ```

   This is simpler and doesn't require changes to QueryBuilder.

### Key considerations

- The Proxy approach works at runtime but is fragile and hard to debug.
- First-class support means better TypeScript types, better error messages, and no conflict with other plugins.
- Backward compatibility: `.with()` on the collection object still works the same way.
- The `RelationsEngine` logic stays the same — only the integration point changes.

### Verification

- `collection.with("author").fetch()` → eager loads relations
- Relations without `.with()` → no eager loading (lazy loading if implemented)
- Multiple plugins registered → no conflicts
- Proxy is removed from `relations/index.ts`
