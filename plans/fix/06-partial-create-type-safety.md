# Issue 11: `Partial<T>` on `create()` Lacks Compile-Time Safety

**Severity:** LOW
**File(s):** `src/collection.ts`
**Status:** Planned

## Problem

`Collection.create()` signature: `async create(data: Partial<T>): Promise<Model<T> & T>`

`Partial<T>` makes ALL fields optional at the type level. Required schema fields are only enforced at runtime in `Schema.validate()`. This means TypeScript doesn't catch missing required fields during development.

## Fix Strategy

Change the input type to `Omit<T, "id"> & { id?: ID }` — all fields from `T` are required except `id` (which can be auto-generated).

### Changes

1. **`src/collection.ts`** — Change `create(data: Partial<T>)` to `create(data: Omit<T, "id"> & { id?: ID })`.

2. **`src/react.ts`** — Update `useMutation`'s `create` type to match.

### Key considerations

- This may cause type errors in existing code where users relied on `Partial<T>` to omit optional fields. Those errors are correct — they reveal missing fields.
- The runtime validation (`Schema.validate()`) remains as a safety net.
- Since `T` is typically `Record<string, unknown>` when no explicit type is provided, the practical impact is minimal until users define typed collections.

### Verification

- `create({ title: "foo", done: true })` → no type error if `title` and `done` are in T
- `create({ title: "foo" })` → type error if `done` is required (but not if marked `required: false` in schema — the `Omit` approach would still require it since it's in T)
- This may need refinement with `Partial` applied only to known-optional fields if we want truly smart types.
