import { describe, expect, it } from "vitest"
import { ConflictResolverEngine } from "../../../src/sync/conflict-resolver"
import type { SyncConflict } from "../../../src/sync/types"

function makeConflict(
  overrides: Partial<SyncConflict> & {
    localTimestamp: string
    remoteTimestamp: string
  },
): SyncConflict {
  return {
    changeId: "chg-1",
    recordId: "rec-1",
    collection: "todos",
    local: { title: "Local", completed: false },
    remote: { title: "Remote", completed: true },
    fieldConflicts: [],
    ...overrides,
  }
}

const EARLIER = "2026-01-01T00:00:00.000Z"
const LATER = "2026-06-01T00:00:00.000Z"

describe("ConflictResolverEngine", () => {
  describe("default strategy (LWW)", () => {
    it("defaults to LWW strategy", () => {
      const engine = new ConflictResolverEngine()
      expect(engine).toBeInstanceOf(ConflictResolverEngine)
    })

    it("resolves local wins when local timestamp is later", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({ localTimestamp: LATER, remoteTimestamp: EARLIER }),
      )
      expect(result.resolution).toBe("local")
    })

    it("resolves remote wins when remote timestamp is later", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({ localTimestamp: EARLIER, remoteTimestamp: LATER }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("resolves remote wins when timestamps are equal (tiebreaker)", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({ localTimestamp: EARLIER, remoteTimestamp: EARLIER }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("resolves remote wins when local data is null (local deleted)", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({
          local: null,
          localTimestamp: EARLIER,
          remoteTimestamp: LATER,
        }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("resolves local wins when remote data is null (remote deleted)", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({
          remote: null,
          localTimestamp: LATER,
          remoteTimestamp: EARLIER,
        }),
      )
      expect(result.resolution).toBe("local")
    })

    it("resolves remote wins when both sides are null", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({
          local: null,
          remote: null,
          localTimestamp: EARLIER,
          remoteTimestamp: LATER,
        }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("handles invalid timestamps gracefully (falls back to 0)", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({ localTimestamp: "not-a-date", remoteTimestamp: "also-not-a-date" }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("handles empty string timestamps gracefully", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(makeConflict({ localTimestamp: "", remoteTimestamp: "" }))
      expect(result.resolution).toBe("remote")
    })
  })

  describe("client-wins strategy", () => {
    it("always resolves local wins", async () => {
      const engine = new ConflictResolverEngine("client-wins")
      const result = await engine.resolve(
        makeConflict({ localTimestamp: EARLIER, remoteTimestamp: LATER }),
      )
      expect(result.resolution).toBe("local")
    })

    it("resolves local even when remote has newer timestamp", async () => {
      const engine = new ConflictResolverEngine("client-wins")
      const result = await engine.resolve(
        makeConflict({
          local: null,
          remote: { title: "Remote" },
          localTimestamp: EARLIER,
          remoteTimestamp: LATER,
        }),
      )
      expect(result.resolution).toBe("local")
    })
  })

  describe("server-wins strategy", () => {
    it("always resolves remote wins", async () => {
      const engine = new ConflictResolverEngine("server-wins")
      const result = await engine.resolve(
        makeConflict({ localTimestamp: LATER, remoteTimestamp: EARLIER }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("resolves remote even when local has newer timestamp", async () => {
      const engine = new ConflictResolverEngine("server-wins")
      const result = await engine.resolve(
        makeConflict({ localTimestamp: LATER, remoteTimestamp: EARLIER }),
      )
      expect(result.resolution).toBe("remote")
    })
  })

  describe("custom strategy", () => {
    it("calls the custom resolver function", async () => {
      const engine = new ConflictResolverEngine("custom", (_conflict) => {
        return { resolution: "local" }
      })
      const result = await engine.resolve(
        makeConflict({ localTimestamp: LATER, remoteTimestamp: EARLIER }),
      )
      expect(result.resolution).toBe("local")
    })

    it("passes the full conflict to the custom resolver", async () => {
      const captured: SyncConflict[] = []
      const engine = new ConflictResolverEngine("custom", (conflict) => {
        captured.push(conflict)
        return { resolution: "remote" }
      })
      const conflict = makeConflict({
        changeId: "chg-custom",
        collection: "notes",
        localTimestamp: LATER,
        remoteTimestamp: EARLIER,
      })
      await engine.resolve(conflict)

      expect(captured.length).toBe(1)
      expect(captured[0]?.changeId).toBe("chg-custom")
      expect(captured[0]?.collection).toBe("notes")
    })

    it("supports async custom resolvers", async () => {
      const engine = new ConflictResolverEngine("custom", async (_conflict) => {
        return { resolution: "remote" }
      })
      const result = await engine.resolve(
        makeConflict({ localTimestamp: LATER, remoteTimestamp: EARLIER }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("supports merged resolution from custom resolver", async () => {
      const engine = new ConflictResolverEngine("custom", (conflict) => {
        const merged = {
          ...conflict.remote,
          ...conflict.local,
          title: `${conflict.local?.title} + ${conflict.remote?.title}`,
        }
        return { resolution: "merged", merged }
      })
      const result = await engine.resolve(
        makeConflict({
          local: { title: "Local", count: 1 },
          remote: { title: "Remote", count: 2 },
          localTimestamp: EARLIER,
          remoteTimestamp: LATER,
        }),
      )
      expect(result.resolution).toBe("merged")
      expect(result.merged).toBeDefined()
      expect(result.merged?.title).toBe("Local + Remote")
      expect(result.merged?.count).toBe(1) // local spread overrides
    })

    it("throws when strategy is custom but no resolver is provided", async () => {
      const engine = new ConflictResolverEngine("custom")
      await expect(
        engine.resolve(makeConflict({ localTimestamp: EARLIER, remoteTimestamp: LATER })),
      ).rejects.toThrow("custom")
    })

    it("propagates errors from custom resolvers", async () => {
      const engine = new ConflictResolverEngine("custom", () => {
        throw new Error("Custom resolver failed")
      })
      await expect(
        engine.resolve(makeConflict({ localTimestamp: EARLIER, remoteTimestamp: LATER })),
      ).rejects.toThrow("Custom resolver failed")
    })

    it("propagates rejections from async custom resolvers", async () => {
      const engine = new ConflictResolverEngine("custom", async () => {
        throw new Error("Async resolver failed")
      })
      await expect(
        engine.resolve(makeConflict({ localTimestamp: EARLIER, remoteTimestamp: LATER })),
      ).rejects.toThrow("Async resolver failed")
    })
  })

  describe("edge cases", () => {
    it("handles undefined local data (deleted)", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({
          local: undefined as unknown as null,
          localTimestamp: EARLIER,
          remoteTimestamp: LATER,
        }),
      )
      expect(result.resolution).toBe("remote")
    })

    it("handles undefined remote data (deleted)", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({
          remote: undefined as unknown as null,
          localTimestamp: LATER,
          remoteTimestamp: EARLIER,
        }),
      )
      expect(result.resolution).toBe("local")
    })

    it("handles same timestamp with same data", async () => {
      const engine = new ConflictResolverEngine("lww")
      const result = await engine.resolve(
        makeConflict({
          local: { title: "Same" },
          remote: { title: "Same" },
          localTimestamp: EARLIER,
          remoteTimestamp: EARLIER,
        }),
      )
      expect(result.resolution).toBe("remote")
    })
  })
})
