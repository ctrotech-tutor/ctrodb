import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { HttpTransport } from "../../../src/sync/http-transport"
import { SyncResponseValidationError } from "../../../src/sync/validation"
import type {
  SyncChangeRecord,
  SyncPushResult,
  SyncPullResult,
} from "../../../src/sync/types"

// ── Helpers ──

function mockFetch(
  status: number,
  body: unknown,
  options?: { ok?: boolean },
): void {
  const isOk = status >= 200 && status < 300
  vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal

        if (signal?.aborted) {
          reject(signal.reason)
          return
        }

        const onAbort = () => {
          reject(signal!.reason)
        }

        signal?.addEventListener("abort", onAbort, { once: true })

        resolve({
          ok: options?.ok ?? isOk,
          status,
          text: () =>
            Promise.resolve(
              typeof body === "string" ? body : JSON.stringify(body),
            ),
          json: () => Promise.resolve(body),
        } as Response)
      })
    },
  )
}

function makeChange(overrides?: Partial<SyncChangeRecord>): SyncChangeRecord {
  return {
    id: "chg-1",
    collection: "todos",
    recordId: "rec-1",
    type: "create",
    data: { title: "Test" },
    prevData: null,
    timestamp: "2026-01-01T00:00:00Z",
    status: "pending",
    retries: 0,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

// ── Tests ──

describe("HttpTransport", () => {
  let transport: HttpTransport

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("constructor", () => {
    it("creates a transport with valid config", () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      expect(transport).toBeInstanceOf(HttpTransport)
      expect(transport.name).toBe("http")
    })
  })

  describe("connect", () => {
    it("sends HEAD request to base URL when no ping endpoint given", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, "")

      await transport.connect()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync",
        expect.objectContaining({ method: "HEAD" }),
      )
      expect(transport.isConnected()).toBe(true)
    })

    it("sends HEAD request to ping endpoint when configured", async () => {
      transport = new HttpTransport({
        url: "https://api.example.com/sync",
        pingEndpoint: "health",
      })
      mockFetch(200, "")

      await transport.connect()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync/health",
        expect.objectContaining({ method: "HEAD" }),
      )
    })

    it("strips trailing slashes from URL", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync/" })
      mockFetch(200, "")

      await transport.connect()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync",
        expect.anything(),
      )
    })

    it("throws when server responds with error", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(503, "Service Unavailable")

      await expect(transport.connect()).rejects.toThrow("Sync server unreachable")
      expect(transport.isConnected()).toBe(false)
    })

    it("throws on network error", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"))

      await expect(transport.connect()).rejects.toThrow("Network error")
      expect(transport.isConnected()).toBe(false)
    })
  })

  describe("disconnect", () => {
    it("sets isConnected to false", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, "")
      await transport.connect()
      expect(transport.isConnected()).toBe(true)

      await transport.disconnect()

      expect(transport.isConnected()).toBe(false)
    })
  })

  describe("push", () => {
    it("sends POST with changes as JSON body", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      const pushResult: SyncPushResult = {
        accepted: [{ id: "chg-1", serverTimestamp: "ts" }],
        conflicts: [],
        errors: [],
      }
      mockFetch(200, pushResult)

      const changes = [makeChange()]
      const result = await transport.push(changes)

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync/push",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ changes }),
        }),
      )
      expect(result).toEqual(pushResult)
    })

    it("merges custom headers", async () => {
      transport = new HttpTransport({
        url: "https://api.example.com/sync",
        headers: { Authorization: "Bearer token123", "X-Custom": "value" },
      })
      mockFetch(200, { accepted: [], conflicts: [], errors: [] })

      await transport.push([makeChange()])

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      expect(fetchCall.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer token123",
        "X-Custom": "value",
      })
    })

    it("throws on non-ok response with status and body", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Invalid request"),
      } as Response)

      await expect(transport.push([makeChange()])).rejects.toThrow(
        "Sync push failed (400): Invalid request",
      )
    })

    it("falls back to Unknown error when response body is empty", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error("Empty body")),
      } as Response)

      await expect(transport.push([makeChange()])).rejects.toThrow(
        "Sync push failed (500): Unknown error",
      )
    })

    it("throws on network error", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Failed to fetch"))

      await expect(transport.push([makeChange()])).rejects.toThrow("Failed to fetch")
    })

    it("propagates abort signal to fetch", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { accepted: [], conflicts: [], errors: [] })

      const controller = new AbortController()
      await transport.push([makeChange()], { signal: controller.signal })

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      expect(fetchCall.signal).toBe(controller.signal)
    })

    it("aborts when external signal is aborted", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { accepted: [], conflicts: [], errors: [] })

      const controller = new AbortController()
      controller.abort(new DOMException("Cancelled", "AbortError"))

      await expect(
        transport.push([makeChange()], { signal: controller.signal }),
      ).rejects.toThrow("Cancelled")
    })
  })

  describe("pull", () => {
    it("sends POST to /pull by default", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      const pullResult: SyncPullResult = {
        changes: [],
        cursor: null,
        hasMore: false,
      }
      mockFetch(200, pullResult)

      const result = await transport.pull()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync/pull",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        }),
      )
      expect(result).toEqual(pullResult)
    })

    it("includes cursor as query parameter", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      await transport.pull({ cursor: "cursor-123" })

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync/pull?cursor=cursor-123",
        expect.anything(),
      )
    })

    it("encodes cursor URL parameter", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      await transport.pull({ cursor: "cursor with spaces/and+symbols" })

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync/pull?cursor=cursor%20with%20spaces%2Fand%2Bsymbols",
        expect.anything(),
      )
    })

    it("includes collections and batchSize in body", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      await transport.pull({
        collections: ["todos", "notes"],
        batchSize: 50,
      })

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      expect(JSON.parse(fetchCall.body as string)).toEqual({
        collections: ["todos", "notes"],
        batchSize: 50,
      })
    })

    it("omits collections when empty", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      await transport.pull({ collections: [] })

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      expect(JSON.parse(fetchCall.body as string)).toEqual({})
    })

    it("uses GET when configured", async () => {
      transport = new HttpTransport({
        url: "https://api.example.com/sync",
        pullMethod: "GET",
      })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      await transport.pull()

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      expect(fetchCall.method).toBe("GET")
      expect(fetchCall.body).toBeUndefined()
    })

    it("includes cursor in GET URL", async () => {
      transport = new HttpTransport({
        url: "https://api.example.com/sync",
        pullMethod: "GET",
      })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      await transport.pull({ cursor: "abc-123" })

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("cursor=abc-123"),
        expect.objectContaining({ method: "GET" }),
      )
    })

    it("strips trailing slash from URL", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync/" })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      await transport.pull()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.example.com/sync/pull",
        expect.anything(),
      )
    })

    it("throws on non-ok response", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal server error"),
      } as Response)

      await expect(transport.pull()).rejects.toThrow(
        "Sync pull failed (500): Internal server error",
      )
    })

    it("propagates abort signal to fetch", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      const controller = new AbortController()
      await transport.pull({ signal: controller.signal })

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      expect(fetchCall.signal).toBe(controller.signal)
    })

    it("aborts when external signal is aborted", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { changes: [], cursor: null, hasMore: false })

      const controller = new AbortController()
      controller.abort(new DOMException("User cancelled", "AbortError"))

      await expect(transport.pull({ signal: controller.signal })).rejects.toThrow(
        "User cancelled",
      )
    })
  })

  describe("timeout", () => {
    it("passes timeout signal to fetch on push", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout")

      transport = new HttpTransport({
        url: "https://api.example.com/sync",
        timeoutMs: 5000,
      })

      mockFetch(200, { accepted: [], conflicts: [], errors: [] })
      await transport.push([makeChange()])

      expect(timeoutSpy).toHaveBeenCalledWith(5000)
      timeoutSpy.mockRestore()
    })

    it("passes timeout signal to fetch on pull", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout")

      transport = new HttpTransport({
        url: "https://api.example.com/sync",
        timeoutMs: 5000,
      })

      mockFetch(200, { changes: [], cursor: null, hasMore: false })
      await transport.pull()

      expect(timeoutSpy).toHaveBeenCalledWith(5000)
      timeoutSpy.mockRestore()
    })

    it("does not pass timeout signal when timeoutMs is not set", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout")

      transport = new HttpTransport({ url: "https://api.example.com/sync" })

      mockFetch(200, { accepted: [], conflicts: [], errors: [] })
      await transport.push([makeChange()])

      expect(timeoutSpy).not.toHaveBeenCalled()
      timeoutSpy.mockRestore()
    })
  })

  describe("isConnected", () => {
    it("returns false before connect", () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      expect(transport.isConnected()).toBe(false)
    })

    it("returns true after successful connect", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, "")
      await transport.connect()
      expect(transport.isConnected()).toBe(true)
    })

    it("returns false after disconnect", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, "")
      await transport.connect()
      await transport.disconnect()
      expect(transport.isConnected()).toBe(false)
    })

    it("remains false after failed connect", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(500, "Error")
      await expect(transport.connect()).rejects.toThrow()
      expect(transport.isConnected()).toBe(false)
    })
  })

  describe("fetchOptions passthrough", () => {
    it("passes fetchOptions to fetch", async () => {
      transport = new HttpTransport({
        url: "https://api.example.com/sync",
        fetchOptions: { cache: "no-cache", mode: "cors" },
      })
      mockFetch(200, { accepted: [], conflicts: [], errors: [] })

      await transport.push([makeChange()])

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit
      expect(fetchCall.cache).toBe("no-cache")
      expect(fetchCall.mode).toBe("cors")
    })
  })

  describe("response validation (GAP-6)", () => {
    it("throws SyncResponseValidationError on malformed push response", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { accepted: "not-an-array", conflicts: [], errors: [] })

      await expect(transport.push([makeChange()])).rejects.toThrow(
        SyncResponseValidationError,
      )
    })

    it("throws SyncResponseValidationError on malformed pull response", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { changes: "not-an-array", cursor: null, hasMore: false })

      await expect(transport.pull()).rejects.toThrow(SyncResponseValidationError)
    })

    it("throws on push response missing accepted array", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { conflicts: [], errors: [] })

      await expect(transport.push([makeChange()])).rejects.toThrow(
        SyncResponseValidationError,
      )
    })

    it("throws on pull response missing changes array", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      mockFetch(200, { cursor: null, hasMore: false })

      await expect(transport.pull()).rejects.toThrow(SyncResponseValidationError)
    })
  })

  describe("429 Retry-After (GAP)", () => {
    function mock429(response: Response): void {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response)
    }

    it("throws with retryAfter as seconds when Retry-After header is seconds", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })

      mock429({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "120" }),
        text: () => Promise.resolve("Rate limited"),
      } as Response)

      try {
        await transport.push([makeChange()])
      } catch (error) {
        const err = error as Error & { retryAfter?: number }
        expect(err.retryAfter).toBe(120000)
        return
      }
      expect.unreachable("Should have thrown")
    })

    it("throws with retryAfter as duration when Retry-After is HTTP-date", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })
      const futureDate = new Date(Date.now() + 5000).toUTCString()

      mock429({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": futureDate }),
        text: () => Promise.resolve("Rate limited"),
      } as Response)

      try {
        await transport.push([makeChange()])
      } catch (error) {
        const err = error as Error & { retryAfter?: number }
        expect(err.retryAfter).toBeGreaterThan(0)
        expect(err.retryAfter).toBeLessThanOrEqual(60000)
        return
      }
      expect.unreachable("Should have thrown")
    })

    it("throws without retryAfter when Retry-After header is missing", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })

      mock429({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: () => Promise.resolve("Rate limited"),
      } as Response)

      try {
        await transport.push([makeChange()])
      } catch (error) {
        const err = error as Error & { retryAfter?: number }
        expect(err.retryAfter).toBeUndefined()
        return
      }
      expect.unreachable("Should have thrown")
    })

    it("throws 429 on pull as well", async () => {
      transport = new HttpTransport({ url: "https://api.example.com/sync" })

      mock429({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "30" }),
        text: () => Promise.resolve("Pull rate limited"),
      } as Response)

      await expect(transport.pull()).rejects.toThrow("rate limited")
    })
  })

  describe("constructor globals check (GAP-18)", () => {
    it("throws if fetch is not available", () => {
      const origFetch = globalThis.fetch
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).fetch

      expect(
        () => new HttpTransport({ url: "https://api.example.com/sync" }),
      ).toThrow("fetch")

      globalThis.fetch = origFetch
    })
  })
})
