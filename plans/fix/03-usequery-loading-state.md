# Issue 3: `useQuery` Returns Bare Array With No Loading State

**Severity:** HIGH
**File(s):** `src/react.ts`, `tests/unit/react.test.tsx`, `tests/integration/react-flow.test.tsx`
**Status:** Planned

## Problem

`useQuery` returns `Array<Model<T> & T>` directly. Initial state is `[]`. The query runs async in `useEffect`. During the async gap, components render with an empty array — indistinguishable from a genuinely empty result set. Errors are silently swallowed (empty catch block).

`useDoc` has the same issue — it delegates to `useQuery` and returns `results[0]`.

## Fix Strategy

### Changes

1. **`src/react.ts`** — Change return type of `useQuery` to `{ data: Array<Model<T> & T>; loading: boolean; error: Error | undefined }`:
   - Add `loading` state initialized to `true`
   - Add `error` state initialized to `undefined`
   - Set `loading = true` before each query run
   - Set `loading = false` in finally block
   - Capture errors instead of swallowing them
   - Add cleanup flag to prevent state updates after unmount

2. **`src/react.ts`** — Update `useDoc` to wrap the new `useQuery` return and expose `{ data, loading, error }`.

3. **`src/react.ts`** — Keep `useMutation` as-is (it already has loading/error states).

### New API

```typescript
const { data: todos, loading, error } = useQuery("todos")
// loading = true during async fetch
// loading = false after fetch completes
// error = Error object if query failed
// data = Array<Model<T> & T> (empty array if no results or not loaded)
```

### Backward compatibility

This is a **breaking change** — the return type switches from `Array` to `{ data, loading, error }`. We'll export the current behavior as `useQueryV1` temporarily if needed, but since ctrodb is v1.x, this is an acceptable breaking change for correctness.

### Verification

- Query on empty collection → `{ data: [], loading: false, error: undefined }`
- Query on non-empty collection → `{ data: [...], loading: false, error: undefined }`
- During async gap → `{ data: [], loading: true, error: undefined }`
- Query error → `{ data: [], loading: false, error: Error }`
- `useDoc` returns `{ data, loading, error }` matching same shape
- React tests updated to destructure new return type
