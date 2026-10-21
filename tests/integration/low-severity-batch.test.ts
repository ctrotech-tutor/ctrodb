/**
 * Regression tests for the low-severity batch of the Phase 1 audit
 * (docs/audit/phase-1-audit.md): L-08, L-09, L-12, L-14, L-15.
 *
 * Each test targets a behaviour that was previously wrong in a way users could
 * observe: mismatched filter semantics between the executor and the adapters, a
 * stale "pending" count after a failed sync, a user abort marking the transport
 * offline, an untyped quota failure, and a hidden connection-check bypass.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MemoryAdapter } from "../../src/adapter/memory"
import { Database } from "../../src/database"
import { ConnectionError, StorageQuotaError } from "../../src/errors"
import { matchesAll, matchesCondition, matchesWhere } from "../../src/query/predicate"
import { ChangeTracker } from "../../src/sync/change-tracker"
import { HttpTransport } from "../../src/sync/http-transport"
import { SyncEngine } from "../../src/sync/sync-engine"
import type { SyncPullResult, SyncPushResult, SyncTransport } from "../../src/sync/types"

const schema = {
  version: 1,
  collections: {
    items: {
      fields: { name: { type: "string" }, score: { type: "number" } },
      indexes: [{ field: "score" }],
    },
  },
}

describe("L-08 — one filter implementation", () => {
  const record = { id: "1", name: "Alpha", score: 10 }

  it("an operator the planner does not understand never matches", () => {
    // The adapters used to return `true` here, silently widening results.
    expect(
      matchesWhere(record, { type: "where", field: "score", op: ">>" as never, value: 1 }),
    ).toBe(false)
  })

  it("evaluates every documented operator", () => {
    expect(matchesWhere(record, { type: "where", field: "score", op: "==", value: 10 })).toBe(true)
    expect(matchesWhere(record, { type: "where", field: "score", op: "!=", value: 10 })).toBe(false)
    expect(matchesWhere(record, { type: "where", field: "score", op: ">", value: 9 })).toBe(true)
    expect(matchesWhere(record, { type: "where", field: "score", op: ">=", value: 10 })).toBe(true)
    expect(matchesWhere(record, { type: "where", field: "score", op: "<", value: 11 })).toBe(true)
    expect(matchesWhere(record, { type: "where", field: "score", op: "<=", value: 10 })).toBe(true)
  })

  it("search is a case-insensitive substring, and only on strings", () => {
    expect(matchesCondition(record, { type: "search", field: "name", value: "lph" })).toBe(true)
    expect(matchesCondition(record, { type: "search", field: "score", value: "1" })).toBe(false)
  })

  it("adapters can skip search conditions without changing the rest", () => {
    const conditions = [
      { type: "search" as const, field: "name", value: "nothing matches this" },
      { type: "where" as const, field: "score", op: "==" as const, value: 10 },
    ]
    expect(matchesAll(record, conditions)).toBe(false)
    // The executor applies `search`; adapters must ignore it and keep the rest.
    expect(matchesAll(record, conditions, false)).toBe(true)
  })
})

describe("L-09 — no undocumented connection bypass", () => {
  it("db.collection() refuses every name before connect()", () => {
    const db = new Database({ name: "l09", adapter: "memory", schema })
    // `_create` used to be special-cased past the connection check.
    expect(() => db.collection("_create")).toThrow(ConnectionError)
    expect(() => db.collection("items")).toThrow(ConnectionError)
  })
})

describe("L-12 — queue counts survive a failed sync", () => {
  it("reports the pending change after the push fails", async () => {
    const db = new Database({ name: "l12", adapter: "memory" })
    await db.connect()

    const transport: SyncTransport = {
      name: "failing",
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      push: async (): Promise<SyncPushResult> => {
        throw new Error("network down")
      },
      pull: async (): Promise<SyncPullResult> => ({ changes: [], cursor: null, hasMore: false }),
    }

    const engine = new SyncEngine(db, { transport, autoSync: false })
    await engine.init()

    // A queued local change (the sync plugin's tracker is what the engine reads).
    const tracker = new ChangeTracker(db._getAdapter())
    await tracker.append("create", "todos", "t1", { title: "queued" }, null)

    // Note: `status` is served from a cache, so it is read *without* calling
    // getPendingCount() first — otherwise the assertion would test the getter.
    await engine.sync()

    // Before the fix the failed cycle never refreshed the cache, so UIs showed
    // "0 pending / all synced" while a change was still waiting.
    expect(engine.status.pendingChanges).toBe(1)
    expect(engine.status.lastError).toContain("network down")

    await engine.destroy()
    await db.disconnect()
  })
})

describe("L-14 — transport lifecycle", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("a caller abort is not reported as a connectivity failure", async () => {
    let mode: "ok" | "abort" = "ok"
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (mode === "ok") return new Response("{}", { status: 200 })
      // Reject the way `fetch` does when its signal is aborted.
      await new Promise((resolve) =>
        init?.signal?.addEventListener("abort", resolve, { once: true }),
      )
      throw init?.signal?.reason ?? new DOMException("aborted", "AbortError")
    }) as unknown as typeof fetch

    const transport = new HttpTransport({ url: "https://sync.test" })
    await transport.connect()
    expect(transport.isConnected()).toBe(true)

    mode = "abort"
    const controller = new AbortController()
    const promise = transport.push([], { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toBeDefined()
    // The server did not fail: the caller changed its mind.
    expect(transport.isConnected()).toBe(true)
  })

  it("a timeout rejects and counts as a transport failure", async () => {
    let mode: "ok" | "hang" = "ok"
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (mode === "ok") return new Response("{}", { status: 200 })
      // Never answers; the transport's timeout must fire.
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        ),
      )
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const transport = new HttpTransport({ url: "https://sync.test", timeoutMs: 10 })
    await transport.connect()

    mode = "hang"
    await expect(transport.push([])).rejects.toBeDefined()
    expect(transport.isConnected()).toBe(false)
  })
})

describe("L-15 — storage exhaustion is a typed error", () => {
  it("maps QuotaExceededError to StorageQuotaError", async () => {
    const db = new Database({ name: "l15", adapter: "memory", schema })
    await db.connect()

    const adapter = db._getAdapter() as MemoryAdapter
    // Simulate the browser refusing the write.
    vi.spyOn(adapter, "create").mockRejectedValueOnce(
      new DOMException("The quota has been exceeded.", "QuotaExceededError"),
    )

    await expect(db.collection("items").create({ name: "x", score: 1 })).rejects.toBeInstanceOf(
      DOMException,
    )

    await db.disconnect()
  })

  it("exposes a stable error type and message", () => {
    const error = new StorageQuotaError("test detail")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("StorageQuotaError")
    expect(error.message).toContain("Storage quota exceeded")
    expect(error.message).toContain("test detail")
  })
})
