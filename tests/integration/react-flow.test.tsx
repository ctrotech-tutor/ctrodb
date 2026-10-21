// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import React from "react"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Database } from "../../src/database"
import { DatabaseProvider, useMutation, useQuery } from "../../src/react"

interface Item {
  label: string
}

const schema = {
  version: 1,
  collections: {
    items: {
      fields: {
        label: { type: "string", required: true },
      },
    },
  },
}

let db: Database

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(DatabaseProvider, { db, children })
}

beforeAll(async () => {
  db = new Database({ name: "react-integration", adapter: "memory", schema })
  await db.connect()
})

afterAll(async () => {
  try {
    await db.disconnect()
  } catch {}
})

describe("react integration", () => {
  it("useMutation create + useQuery reads reactively", async () => {
    const { result: queryResult } = renderHook(() => useQuery<Item>("items"), { wrapper })
    const { result: mutationResult } = renderHook(() => useMutation<Item>("items"), { wrapper })

    await waitFor(() => {
      expect(queryResult.current.loading).toBe(false)
      expect(queryResult.current.data).toHaveLength(0)
    })

    await act(async () => {
      await mutationResult.current.create({ label: "alpha" })
    })

    await waitFor(() => {
      expect(queryResult.current.data.length).toBe(1)
    })

    const item = queryResult.current.data[0]
    expect(item.label).toBe("alpha")
  })

  it("useMutation update triggers query re-render", async () => {
    const { result: queryResult } = renderHook(() => useQuery<Item>("items"), { wrapper })
    const { result: mutationResult } = renderHook(() => useMutation<Item>("items"), { wrapper })

    let createdId: string
    await act(async () => {
      const item = await mutationResult.current.create({ label: "before" })
      createdId = item.id as string
    })

    await act(async () => {
      await mutationResult.current.update(createdId, { label: "after" })
    })

    await waitFor(() => {
      const found = queryResult.current.data.find((i) => i.id === createdId)
      expect(found?.label).toBe("after")
    })
  })

  it("useMutation delete removes from query results", async () => {
    const { result: queryResult } = renderHook(() => useQuery<Item>("items"), { wrapper })
    const { result: mutationResult } = renderHook(() => useMutation<Item>("items"), { wrapper })

    let createdId: string
    await act(async () => {
      const item = await mutationResult.current.create({ label: "delete-me" })
      createdId = item.id as string
    })

    await waitFor(() => {
      expect(queryResult.current.data.some((i) => i.id === createdId)).toBe(true)
    })

    await act(async () => {
      await mutationResult.current.delete(createdId)
    })

    await waitFor(() => {
      expect(queryResult.current.data.some((i) => i.id === createdId)).toBe(false)
    })
  })
})

describe("useQuery robustness (M-16)", () => {
  /**
   * The previous implementation spread `deps` into the effect's dependency
   * array. React requires a constant array size, so a caller whose deps array
   * changed length got a hard error and a broken hook.
   */
  it("tolerates a deps array whose length changes between renders", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    const { result, rerender } = renderHook(
      ({ deps }: { deps: unknown[] }) =>
        useQuery<Item>("items", (q) => q.where("label", "==", "dep-length"), deps),
      { wrapper, initialProps: { deps: [] as unknown[] } },
    )

    await waitFor(() => expect(result.current.loading).toBe(false))

    // Growing the array must not make React complain about a dependency list
    // whose size changed between renders — the old implementation spread it in.
    rerender({ deps: ["a"] })
    rerender({ deps: ["a", 42, { nested: true }] })
    await waitFor(() => expect(result.current.loading).toBe(false))

    const complained = consoleError.mock.calls.some((args) =>
      args.some(
        (arg) =>
          typeof arg === "string" &&
          /dependency array|changed size|final argument passed to useEffect|keep the same size/i.test(
            arg,
          ),
      ),
    )
    expect(complained).toBe(false)

    await act(async () => {
      await db.collection<Item>("items").create({ label: "dep-length" })
    })

    await waitFor(() => expect(result.current.data).toHaveLength(1))
    consoleError.mockRestore()
  })

  /**
   * Two overlapping fetches used to race: whichever resolved last won, even if
   * it had been issued first with older parameters. This happens inside a
   * single effect when a change event refetches while the initial load is still
   * in flight.
   */
  it("discards a stale response that resolves after a newer one", async () => {
    const adapter = db._getAdapter()

    let releaseSlow: (() => void) | null = null
    const slowStarted = new Promise<void>((resolve) => {
      const spy = vi.spyOn(adapter, "findAll")
      spy.mockImplementationOnce(async () => {
        resolve()
        await new Promise<void>((done) => {
          releaseSlow = done
        })
        return [{ id: "stale", label: "race" }]
      })
    })

    const { result } = renderHook(
      () => useQuery<Item>("items", (q) => q.where("label", "==", "race")),
      { wrapper },
    )

    // The first fetch is held open…
    await slowStarted

    // …then a change event triggers a second, fast refetch.
    await act(async () => {
      await db.collection<Item>("items").create({ label: "race" })
    })
    await waitFor(() => expect(result.current.data).toHaveLength(1))

    // Releasing the stale response must not resurrect the old snapshot.
    releaseSlow?.()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(result.current.data.map((i) => i.id)).not.toContain("stale")
    vi.restoreAllMocks()
  })

  it("coalesces a burst of change events into a single refetch", async () => {
    const { result } = renderHook(
      () => useQuery<Item>("items", (q) => q.where("label", "==", "burst")),
      {
        wrapper,
      },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    const adapter = db._getAdapter()
    const spy = vi.spyOn(adapter, "findAll")

    await act(async () => {
      const items = db.collection<Item>("items")
      for (let i = 0; i < 25; i++) {
        await items.create({ label: "burst" })
      }
    })

    await waitFor(() => expect(result.current.data).toHaveLength(25), { timeout: 2000 })
    // 25 events, but at most a couple of queries (the 16ms window may split a
    // slow machine's burst, so allow a small margin).
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)

    spy.mockRestore()
  })

  it("does not flip loading back on for a background refresh", async () => {
    const { result } = renderHook(
      () => useQuery<Item>("items", (q) => q.where("label", "==", "flicker")),
      {
        wrapper,
      },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await db.collection<Item>("items").create({ label: "flicker" })
    })

    // The data updates without the hook ever reporting a loading state again.
    await waitFor(() => expect(result.current.data).toHaveLength(1))
    expect(result.current.loading).toBe(false)
  })
})
