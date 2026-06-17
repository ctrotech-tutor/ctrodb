// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import React from "react"
import { Database } from "../../src/database"
import { useQuery, useDoc, useMutation, DatabaseProvider } from "../../src/react"

const testSchema = {
  version: 1,
  collections: {
    tasks: {
      fields: {
        title: { type: "string", required: true },
        done: { type: "boolean", default: false },
      },
    },
  },
}

let db: Database

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(DatabaseProvider, { db, children })
}

beforeAll(async () => {
  db = new Database({ name: "react_test", adapter: "memory", schema: testSchema })
  await db.connect()
})

afterAll(async () => {
  await db.disconnect()
})

describe("useQuery", () => {
  it("returns empty array initially for empty collection", async () => {
    const { result } = renderHook(() => useQuery("nonexistent"), { wrapper })

    await waitFor(() => {
      expect(Array.isArray(result.current)).toBe(true)
    })
  })

  it("returns records after they are created", async () => {
    await act(async () => {
      await db.collection("tasks").create({ title: "Test Task", done: false })
    })

    const { result } = renderHook(() => useQuery("tasks"), { wrapper })

    await waitFor(() => {
      expect(result.current.length).toBeGreaterThanOrEqual(1)
    })

    const task = result.current.find((t: any) => t.title === "Test Task")
    expect(task).toBeDefined()
    expect((task as any).title).toBe("Test Task")
  })

  it("applies query filter", async () => {
    await act(async () => {
      await db.collection("tasks").create({ title: "Done Task", done: true })
    })

    const { result } = renderHook(() =>
      useQuery("tasks", (q) => q.where("done", "==", true)),
    { wrapper },
    )

    await waitFor(() => {
      expect(result.current.length).toBeGreaterThanOrEqual(1)
    })

    for (const task of result.current) {
      expect((task as any).done).toBe(true)
    }
  })
})

describe("useDoc", () => {
  it("returns undefined for non-existent id", async () => {
    const { result } = renderHook(() => useDoc("tasks", 99999), { wrapper })

    await waitFor(() => {
      expect(result.current).toBeUndefined()
    })
  })

  it("returns a record by id", async () => {
    let createdId: any
    await act(async () => {
      const task = await db.collection("tasks").create({ title: "Doc Test" })
      createdId = task.id
    })

    const { result } = renderHook(() => useDoc("tasks", createdId), { wrapper })

    await waitFor(() => {
      expect(result.current).toBeDefined()
      expect((result.current as any).title).toBe("Doc Test")
    })
  })
})

describe("useMutation", () => {
  it("provides create, update, delete functions", () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    expect(typeof result.current.create).toBe("function")
    expect(typeof result.current.update).toBe("function")
    expect(typeof result.current.delete).toBe("function")
    expect(typeof result.current.reset).toBe("function")
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it("create adds a record", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    let created: any
    await act(async () => {
      created = await result.current.create({ title: "Mutation Test" })
    })

    expect(created).toBeDefined()
    expect((created as any).title).toBe("Mutation Test")
  })

  it("update modifies a record", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    let created: any
    await act(async () => {
      created = await result.current.create({ title: "Update Test" })
    })

    let updated: any
    await act(async () => {
      updated = await result.current.update(created.id, { title: "Updated" })
    })

    expect((updated as any).title).toBe("Updated")
  })

  it("delete removes a record", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    let created: any
    await act(async () => {
      created = await result.current.create({ title: "Delete Test" })
    })

    await act(async () => {
      await result.current.delete(created.id)
    })

    const found = await db.collection("tasks").get(created.id)
    expect(found).toBeUndefined()
  })

  it("reset clears error", async () => {
    const { result } = renderHook(() => useMutation("tasks"), { wrapper })

    act(() => {
      result.current.reset()
    })

    expect(result.current.error).toBeUndefined()
    expect(result.current.loading).toBe(false)
  })
})

describe("DatabaseProvider", () => {
  it("provides database through context", () => {
    const { result } = renderHook(() => useQuery("tasks"), { wrapper })

    expect(Array.isArray(result.current)).toBe(true)
  })
})
