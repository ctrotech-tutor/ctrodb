// @vitest-environment jsdom

import { describe, expect, it, afterAll, beforeAll } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import React from "react"
import { Database } from "../../src/database"
import { useMutation, useQuery, DatabaseProvider } from "../../src/react"

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
  try { await db.disconnect() } catch {}
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
