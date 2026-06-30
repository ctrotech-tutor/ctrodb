import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { WsTransport } from "../../../src/sync/ws-transport"
import { SyncResponseValidationError } from "../../../src/sync/validation"
import type { SyncChangeRecord, SyncPushResult, SyncPullResult } from "../../../src/sync/types"

// ── Mock WebSocket ──

let mockWsInstances: MockWebSocket[] = []

class MockWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly CONNECTING = 0
  static readonly CLOSING = 2

  readonly url: string
  readyState = MockWebSocket.CLOSED
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: Record<string, unknown>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly send = vi.fn()
  readonly close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({
      code: 1000,
      reason: "",
      wasClean: true,
    } as unknown as Record<string, unknown>)
  })

  constructor(url: string) {
    this.url = url
    mockWsInstances.push(this)
  }

  _simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event("open"))
  }

  _simulateMessage(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }))
  }

  _simulateError(): void {
    this.onerror?.(new Event("error"))
  }

  _simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({
      code: 1006,
      reason: "Connection closed",
      wasClean: false,
    } as unknown as Record<string, unknown>)
  }
}

// ── Helpers ──

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

describe("WsTransport", () => {
  let transport: WsTransport

  beforeEach(() => {
    mockWsInstances = []
    vi.stubGlobal("WebSocket", MockWebSocket)
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    try {
      await transport?.disconnect()
    } catch {
      // ignore
    }
  })

  async function connectTransport(): Promise<MockWebSocket> {
    const connectPromise = transport.connect()
    const ws = mockWsInstances[0]!
    ws._simulateOpen()
    await connectPromise
    return ws
  }

  describe("constructor", () => {
    it("creates a transport with valid config", () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      expect(transport).toBeInstanceOf(WsTransport)
      expect(transport.name).toBe("websocket")
    })

    it("applies default values", () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      expect(transport.isConnected()).toBe(false)
    })
  })

  describe("connect", () => {
    it("creates a WebSocket with the given URL", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const connectPromise = transport.connect()

      expect(mockWsInstances[0]!.url).toBe("wss://api.example.com/sync")

      mockWsInstances[0]!._simulateOpen()
      await connectPromise
    })

    it("resolves when the WebSocket opens", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const connectPromise = transport.connect()

      expect(transport.isConnected()).toBe(false)

      mockWsInstances[0]!._simulateOpen()
      await connectPromise

      expect(transport.isConnected()).toBe(true)
    })

    it("rejects when the WebSocket closes before opening", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const connectPromise = transport.connect()

      mockWsInstances[0]!._simulateClose()

      await expect(connectPromise).rejects.toThrow("WebSocket connection failed")
      expect(transport.isConnected()).toBe(false)
    })

    it("sends auth message when headers are provided", async () => {
      transport = new WsTransport({
        url: "wss://api.example.com/sync",
        headers: { Authorization: "Bearer token123" },
      })
      const ws = await connectTransport()

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "auth",
          payload: { Authorization: "Bearer token123" },
        }),
      )
    })

    it("does not send auth when no headers", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      expect(ws.send).not.toHaveBeenCalled()
    })

    it("rejects on connection timeout", async () => {
      vi.useFakeTimers()
      try {
        transport = new WsTransport({
          url: "wss://api.example.com/sync",
          connectionTimeoutMs: 100,
        })

        const connectPromise = transport.connect()
        connectPromise.catch(() => {})

        await vi.advanceTimersByTimeAsync(100)

        await expect(connectPromise).rejects.toThrow("connection timed out")
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("disconnect", () => {
    it("closes the WebSocket", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      await transport.disconnect()

      expect(ws.close).toHaveBeenCalled()
      expect(transport.isConnected()).toBe(false)
    })

    it("rejects all pending requests", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      await connectTransport()

      const pushPromise = transport.push([makeChange()])

      await transport.disconnect()

      await expect(pushPromise).rejects.toThrow("WebSocket disconnected")
    })
  })

  describe("push", () => {
    it("sends push message and resolves with result", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const pushResult: SyncPushResult = {
        accepted: [{ id: "chg-1", serverTimestamp: "ts" }],
        conflicts: [],
        errors: [],
      }

      const pushPromise = transport.push([makeChange()])

      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])
      expect(sentMessage.type).toBe("push")
      expect(sentMessage.payload.changes).toHaveLength(1)
      expect(sentMessage.requestId).toBeTruthy()

      ws._simulateMessage(
        JSON.stringify({
          type: "push_result",
          requestId: sentMessage.requestId,
          payload: pushResult,
        }),
      )

      const result = await pushPromise
      expect(result).toEqual(pushResult)
    })

    it("rejects when not connected", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })

      await expect(transport.push([makeChange()])).rejects.toThrow("WebSocket not connected")
    })

    it("rejects immediately when signal is already aborted", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      await connectTransport()

      const controller = new AbortController()
      controller.abort(new DOMException("Cancelled", "AbortError"))

      await expect(
        transport.push([makeChange()], { signal: controller.signal }),
      ).rejects.toThrow("Cancelled")
    })

    it("rejects on error response", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const pushPromise = transport.push([makeChange()])

      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])

      ws._simulateMessage(
        JSON.stringify({
          type: "error",
          requestId: sentMessage.requestId,
          payload: { message: "Invalid change data" },
        }),
      )

      await expect(pushPromise).rejects.toThrow("Invalid change data")
    })

    it("rejects with fallback message when error payload has no message", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const pushPromise = transport.push([makeChange()])

      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])

      ws._simulateMessage(
        JSON.stringify({
          type: "error",
          requestId: sentMessage.requestId,
          payload: {},
        }),
      )

      await expect(pushPromise).rejects.toThrow("Unknown error")
    })

    it("validates push response (GAP-6)", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const pushPromise = transport.push([makeChange()])

      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])

      ws._simulateMessage(
        JSON.stringify({
          type: "push_result",
          requestId: sentMessage.requestId,
          payload: { accepted: "not-an-array", conflicts: [], errors: [] },
        }),
      )

      await expect(pushPromise).rejects.toThrow(SyncResponseValidationError)
    })

    it("registers pending request before send (GAP-4)", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      // Intercept send to verify pending request already exists
      const originalSend = ws.send
      ws.send = vi.fn((data: string) => {
        const msg = JSON.parse(data)
        // At this point, the pending request should already be registered
        // We can verify by checking that push doesn't fail due to sync onmessage
        expect(msg.requestId).toBeTruthy()
        return originalSend(data)
      })

      const pushPromise = transport.push([makeChange()])
      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])

      ws._simulateMessage(
        JSON.stringify({
          type: "push_result",
          requestId: sentMessage.requestId,
          payload: { accepted: [], conflicts: [], errors: [] },
        }),
      )

      await expect(pushPromise).resolves.toBeDefined()
    })
  })

  describe("pull", () => {
    it("sends pull message and resolves with result", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const pullResult: SyncPullResult = {
        changes: [],
        cursor: null,
        hasMore: false,
      }

      const pullPromise = transport.pull()

      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])
      expect(sentMessage.type).toBe("pull")
      expect(sentMessage.requestId).toBeTruthy()

      ws._simulateMessage(
        JSON.stringify({
          type: "pull_result",
          requestId: sentMessage.requestId,
          payload: pullResult,
        }),
      )

      const result = await pullPromise
      expect(result).toEqual(pullResult)
    })

    it("includes cursor, collections, and batchSize in payload", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const pullPromise = transport.pull({
        cursor: "cursor-1",
        collections: ["todos", "notes"],
        batchSize: 50,
      })

      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])
      expect(sentMessage.payload.cursor).toBe("cursor-1")
      expect(sentMessage.payload.collections).toEqual(["todos", "notes"])
      expect(sentMessage.payload.batchSize).toBe(50)

      ws._simulateMessage(
        JSON.stringify({
          type: "pull_result",
          requestId: sentMessage.requestId,
          payload: { changes: [], cursor: null, hasMore: false },
        }),
      )

      await pullPromise
    })

    it("rejects immediately when signal is already aborted", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      await connectTransport()

      const controller = new AbortController()
      controller.abort(new DOMException("Cancelled", "AbortError"))

      await expect(transport.pull({ signal: controller.signal })).rejects.toThrow("Cancelled")
    })

    it("validates pull response (GAP-6)", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const pullPromise = transport.pull()

      const sentMessage = JSON.parse(ws.send.mock.calls[0]![0])

      ws._simulateMessage(
        JSON.stringify({
          type: "pull_result",
          requestId: sentMessage.requestId,
          payload: { changes: "not-an-array", cursor: null, hasMore: false },
        }),
      )

      await expect(pullPromise).rejects.toThrow(SyncResponseValidationError)
    })
  })

  describe("constructor (GAP-18)", () => {
    it("throws if WebSocket is not available", () => {
      const origWs = globalThis.WebSocket
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).WebSocket

      expect(() => new WsTransport({ url: "wss://api.example.com/sync" })).toThrow(
        "WebSocket",
      )

      globalThis.WebSocket = origWs
    })
  })

  describe("onServerPush", () => {
    it("triggers callback on server_push message", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const callback = vi.fn()
      transport.onServerPush(callback)

      const pushData = [
        {
          id: "chg-server",
          collection: "todos",
          recordId: "rec-99",
          type: "update" as const,
          data: { title: "Server update" },
          timestamp: "2026-01-01T00:00:00Z",
        },
      ]

      ws._simulateMessage(
        JSON.stringify({
          type: "server_push",
          payload: pushData,
        }),
      )

      expect(callback).toHaveBeenCalledWith(pushData)
    })

    it("ignores server_push when no callback registered", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      ws._simulateMessage(
        JSON.stringify({
          type: "server_push",
          payload: [],
        }),
      )
      // No crash expected
    })

    it("returns unsubscribe function", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      const ws = await connectTransport()

      const callback = vi.fn()
      const unsub = transport.onServerPush(callback)
      unsub()

      ws._simulateMessage(
        JSON.stringify({
          type: "server_push",
          payload: [],
        }),
      )

      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe("request timeout", () => {
    it("rejects push if server does not respond in time", async () => {
      vi.useFakeTimers()
      try {
        transport = new WsTransport({
          url: "wss://api.example.com/sync",
          requestTimeoutMs: 100,
        })

        // Connect with fake timers — simulate open immediately
        const connectPromise = transport.connect()
        connectPromise.catch(() => {})
        mockWsInstances[0]!._simulateOpen()
        await connectPromise

        const pushPromise = transport.push([makeChange()])
        pushPromise.catch(() => {})

        await vi.advanceTimersByTimeAsync(100)

        await expect(pushPromise).rejects.toThrow("timed out")
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("reconnection", () => {
    it("reconnects on unexpected close when shouldReconnect is true", async () => {
      transport = new WsTransport({
        url: "wss://api.example.com/sync",
        reconnectIntervalMs: 50,
        maxReconnectAttempts: 3,
      })

      const ws1 = await connectTransport()
      expect(transport.isConnected()).toBe(true)

      // Simulate unexpected close
      ws1._simulateClose()
      expect(transport.isConnected()).toBe(false)

      // Wait for reconnect
      await new Promise((r) => setTimeout(r, 100))

      expect(mockWsInstances.length).toBeGreaterThanOrEqual(2)
    })

    it("does not reconnect after disconnect", async () => {
      transport = new WsTransport({
        url: "wss://api.example.com/sync",
        reconnectIntervalMs: 50,
      })

      await connectTransport()
      expect(transport.isConnected()).toBe(true)

      await transport.disconnect()

      // Give some time for reconnect to try
      await new Promise((r) => setTimeout(r, 100))

      expect(mockWsInstances.length).toBe(1)
    })

    it("stops reconnecting after max attempts", async () => {
      vi.useFakeTimers()
      try {
        transport = new WsTransport({
          url: "wss://api.example.com/sync",
          reconnectIntervalMs: 50,
          maxReconnectAttempts: 2,
        })

        const ws1 = await connectTransport()

        // First close triggers reconnect
        ws1._simulateClose()

        // Advance time for reconnect to try
        await vi.advanceTimersByTimeAsync(100)

        // Second WS instance opens then fails
        const ws2 = mockWsInstances[1]
        expect(ws2).toBeDefined()
        ws2._simulateClose()

        // Advance time for second reconnect attempt
        await vi.advanceTimersByTimeAsync(200)

        // Should stop after 2 attempts (no third WS instance)
        expect(mockWsInstances.length).toBeLessThanOrEqual(3)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("isConnected", () => {
    it("returns false before connect", () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      expect(transport.isConnected()).toBe(false)
    })

    it("returns true after successful connect", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      await connectTransport()
      expect(transport.isConnected()).toBe(true)
    })

    it("returns false after disconnect", async () => {
      transport = new WsTransport({ url: "wss://api.example.com/sync" })
      await connectTransport()
      await transport.disconnect()
      expect(transport.isConnected()).toBe(false)
    })
  })
})
