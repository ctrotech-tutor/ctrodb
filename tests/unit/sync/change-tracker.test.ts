import { describe, it, expect, beforeEach } from "vitest"
import { MemoryAdapter } from "../../../src/adapter/memory"
import { ChangeTracker } from "../../../src/sync/change-tracker"
import type { SyncChangeRecord } from "../../../src/sync/types"

function createTracker(): { tracker: ChangeTracker; adapter: MemoryAdapter } {
  const adapter = new MemoryAdapter()
  const tracker = new ChangeTracker(adapter)
  return { tracker, adapter }
}

async function seed(tracker: ChangeTracker, overrides: Partial<SyncChangeRecord>[]): Promise<string[]> {
  const ids: string[] = []
  for (const override of overrides) {
    const id = await tracker.append(
      override.type ?? "create",
      override.collection ?? "test",
      override.recordId ?? "rec-1",
      override.data ?? { name: "test" },
      override.prevData ?? null,
    )
    ids.push(id)
  }
  return ids
}

async function setStatus(tracker: ChangeTracker, id: string, status: string): Promise<void> {
  switch (status) {
    case "syncing":
      await tracker.markSyncing([id])
      break
    case "committed":
      await tracker.markCommitted(id)
      break
    case "failed":
      await tracker.markFailed(id, "test error")
      break
  }
}

describe("ChangeTracker", () => {
  let tracker: ChangeTracker
  let adapter: MemoryAdapter

  beforeEach(() => {
    const ctx = createTracker()
    tracker = ctx.tracker
    adapter = ctx.adapter
  })

  describe("init", () => {
    it("resets stuck syncing changes to pending", async () => {
      const [id] = await seed(tracker, [{ type: "update" }])
      await tracker.markSyncing([id])

      await tracker.init()

      const record = await tracker.getById(id)
      expect(record?.status).toBe("pending")
      expect(record?.retries).toBe(1)
    })

    it("does not touch committed changes", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      await tracker.markCommitted(id)

      await tracker.init()

      const record = await tracker.getById(id)
      expect(record?.status).toBe("committed")
    })

    it("does not touch pending changes", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])

      await tracker.init()

      const record = await tracker.getById(id)
      expect(record?.status).toBe("pending")
    })

    it("does not touch failed changes", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      await tracker.markFailed(id, "error")

      await tracker.init()

      const record = await tracker.getById(id)
      expect(record?.status).toBe("failed")
    })

    it("handles empty store gracefully", async () => {
      await expect(tracker.init()).resolves.toBeUndefined()
    })
  })

  describe("append", () => {
    it("creates a change record with correct fields", async () => {
      const id = await tracker.append(
        "create",
        "todos",
        "rec-123",
        { title: "Hello", completed: false },
        null,
      )

      expect(id).toBeTruthy()
      expect(typeof id).toBe("string")

      const record = await tracker.getById(id)
      expect(record).toBeDefined()
      expect(record?.collection).toBe("todos")
      expect(record?.recordId).toBe("rec-123")
      expect(record?.type).toBe("create")
      expect(record?.data).toEqual({ title: "Hello", completed: false })
      expect(record?.prevData).toBeNull()
      expect(record?.status).toBe("pending")
      expect(record?.retries).toBe(0)
      expect(record?.errorMessage).toBeNull()
      expect(record?.timestamp).toBeTruthy()
      expect(record?.createdAt).toBeTruthy()
      expect(record?.updatedAt).toBeTruthy()
    })

    it("accepts prevData for updates", async () => {
      const id = await tracker.append("update", "todos", "rec-1", { title: "Updated" }, {
        title: "Original",
      } as unknown as Record<string, unknown>)

      const record = await tracker.getById(id)
      expect(record?.prevData).toEqual({ title: "Original" })
    })

    it("stores null data for deletes", async () => {
      const id = await tracker.append("delete", "todos", "rec-1", null)

      const record = await tracker.getById(id)
      expect(record?.data).toBeNull()
    })

    it("generates unique IDs each call", async () => {
      const id1 = await tracker.append("create", "todos", "rec-1", {})
      const id2 = await tracker.append("create", "todos", "rec-1", {})
      expect(id1).not.toBe(id2)
    })
  })

  describe("getPending", () => {
    it("returns changes sorted by timestamp ascending", async () => {
      const ids = await seed(tracker, [
        { type: "create", data: { order: 1 } },
        { type: "create", data: { order: 2 } },
        { type: "create", data: { order: 3 } },
      ])

      const pending = await tracker.getPending()

      expect(pending.length).toBe(3)
      expect(pending[0]?.createdAt <= pending[1]?.createdAt).toBe(true)
      expect(pending[1]?.createdAt <= pending[2]?.createdAt).toBe(true)
    })

    it("includes pending changes", async () => {
      await seed(tracker, [{ type: "create" }])

      const pending = await tracker.getPending()
      expect(pending.length).toBe(1)
    })

    it("includes failed changes", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      await tracker.markFailed(id, "error")

      const pending = await tracker.getPending()
      expect(pending.length).toBe(1)
    })

    it("excludes syncing changes", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      await tracker.markSyncing([id])

      const pending = await tracker.getPending()
      expect(pending.length).toBe(0)
    })

    it("excludes committed changes", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      await tracker.markCommitted(id)

      const pending = await tracker.getPending()
      expect(pending.length).toBe(0)
    })

    it("returns empty array when no pending changes", async () => {
      const pending = await tracker.getPending()
      expect(pending).toEqual([])
    })
  })

  describe("markSyncing", () => {
    it("updates status to syncing", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])

      await tracker.markSyncing([id])

      const record = await tracker.getById(id)
      expect(record?.status).toBe("syncing")
    })

    it("updates multiple records at once", async () => {
      const ids = await seed(tracker, [
        { type: "create" },
        { type: "update" },
      ])

      await tracker.markSyncing(ids)

      const all = await tracker.getAll()
      expect(all.every((c) => c.status === "syncing")).toBe(true)
    })

    it("updates updatedAt timestamp", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      const before = (await tracker.getById(id))?.updatedAt

      await new Promise((r) => setTimeout(r, 10))
      await tracker.markSyncing([id])

      const after = (await tracker.getById(id))?.updatedAt
      expect(after).not.toBe(before)
    })
  })

  describe("markCommitted", () => {
    it("updates status to committed", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])

      await tracker.markCommitted(id)

      const record = await tracker.getById(id)
      expect(record?.status).toBe("committed")
    })

    it("stores serverTimestamp if provided", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])

      await tracker.markCommitted(id, { serverTimestamp: "2026-06-28T00:00:00Z" })

      const record = await tracker.getById(id) as Record<string, unknown>
      expect(record.serverTimestamp).toBe("2026-06-28T00:00:00Z")
    })
  })

  describe("markFailed", () => {
    it("updates status to failed with error message", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])

      await tracker.markFailed(id, "Network error")

      const record = await tracker.getById(id)
      expect(record?.status).toBe("failed")
      expect(record?.errorMessage).toBe("Network error")
    })

    it("increments retries", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])

      await tracker.markFailed(id, "error 1")
      expect((await tracker.getById(id))?.retries).toBe(1)

      await tracker.markFailed(id, "error 2")
      expect((await tracker.getById(id))?.retries).toBe(2)
    })

    it("does nothing if record does not exist", async () => {
      await expect(tracker.markFailed("nonexistent", "error")).resolves.toBeUndefined()
    })
  })

  describe("markPending", () => {
    it("resets a failed change to pending", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      await tracker.markFailed(id, "error")

      await tracker.markPending(id)

      const record = await tracker.getById(id)
      expect(record?.status).toBe("pending")
    })

    it("resets a syncing change to pending", async () => {
      const [id] = await seed(tracker, [{ type: "create" }])
      await tracker.markSyncing([id])

      await tracker.markPending(id)

      const record = await tracker.getById(id)
      expect(record?.status).toBe("pending")
    })
  })

  describe("countByStatus", () => {
    it("counts by status", async () => {
      const ids = await seed(tracker, [
        { type: "create" },
        { type: "create" },
        { type: "create" },
      ])
      await tracker.markSyncing([ids[0]!])
      await tracker.markCommitted(ids[1]!)
      await tracker.markFailed(ids[2]!, "error")

      expect(await tracker.countByStatus("pending")).toBe(0)
      expect(await tracker.countByStatus("syncing")).toBe(1)
      expect(await tracker.countByStatus("committed")).toBe(1)
      expect(await tracker.countByStatus("failed")).toBe(1)
    })

    it("returns 0 when no matches", async () => {
      expect(await tracker.countByStatus("pending")).toBe(0)
    })
  })

  describe("countPending", () => {
    it("counts pending and failed changes", async () => {
      const ids = await seed(tracker, [
        { type: "create" },
        { type: "create" },
      ])
      await tracker.markFailed(ids[1]!, "error")

      expect(await tracker.countPending()).toBe(2)
    })

    it("excludes syncing and committed", async () => {
      const ids = await seed(tracker, [
        { type: "create" },
        { type: "create" },
        { type: "create" },
      ])
      await tracker.markSyncing([ids[0]!])
      await tracker.markCommitted(ids[1]!)

      expect(await tracker.countPending()).toBe(1)
    })
  })

  describe("removeCommitted", () => {
    it("removes all committed changes", async () => {
      const ids = await seed(tracker, [
        { type: "create" },
        { type: "create" },
        { type: "create" },
      ])
      await tracker.markCommitted(ids[0]!)
      await tracker.markCommitted(ids[1]!)

      const removed = await tracker.removeCommitted()

      expect(removed).toBe(2)
      const all = await tracker.getAll()
      expect(all.length).toBe(1)
      expect(all[0]?.id).toBe(ids[2])
    })

    it("returns 0 when no committed changes", async () => {
      await seed(tracker, [{ type: "create" }])
      expect(await tracker.removeCommitted()).toBe(0)
    })

    it("handles empty store", async () => {
      expect(await tracker.removeCommitted()).toBe(0)
    })
  })

  describe("getAll", () => {
    it("returns all records", async () => {
      await seed(tracker, [
        { type: "create" },
        { type: "update" },
      ])

      const all = await tracker.getAll()
      expect(all.length).toBe(2)
    })

    it("returns empty array for empty store", async () => {
      expect(await tracker.getAll()).toEqual([])
    })
  })

  describe("getFailed", () => {
    it("returns only failed changes", async () => {
      const ids = await seed(tracker, [
        { type: "create" },
        { type: "create" },
      ])
      await tracker.markFailed(ids[0]!, "error")

      const failed = await tracker.getFailed()
      expect(failed.length).toBe(1)
      expect(failed[0]?.id).toBe(ids[0])
    })

    it("returns empty array when no failures", async () => {
      await seed(tracker, [{ type: "create" }])
      expect(await tracker.getFailed()).toEqual([])
    })
  })

  describe("getById", () => {
    it("returns the change by ID", async () => {
      const [id] = await seed(tracker, [{ type: "create", data: { title: "Test" } }])

      const found = await tracker.getById(id)
      expect(found).toBeDefined()
      expect(found?.data).toEqual({ title: "Test" })
    })

    it("returns undefined for nonexistent ID", async () => {
      const found = await tracker.getById("nonexistent")
      expect(found).toBeUndefined()
    })
  })

  describe("storeName", () => {
    it("uses the correct store name", () => {
      expect(tracker.storeName).toBe("_ctrodb_sync_changes")
    })
  })
})
