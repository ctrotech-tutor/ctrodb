import type {
  PullOptions,
  PushOptions,
  SyncChangeRecord,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "./types"

export interface WsTransportConfig {
  url: string
  headers?: Record<string, string>
  reconnectIntervalMs?: number
  maxReconnectAttempts?: number
  requestTimeoutMs?: number
  connectionTimeoutMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface WsMessage {
  type: "push" | "pull" | "push_result" | "pull_result" | "server_push" | "error" | "auth"
  requestId?: string
  payload?: unknown
}

const DEFAULT_RECONNECT_INTERVAL = 3000
const DEFAULT_MAX_RECONNECT = 10
const DEFAULT_REQUEST_TIMEOUT = 30000
const DEFAULT_CONNECTION_TIMEOUT = 10000
const MAX_BACKOFF_MS = 300000

type ServerPushCallback = (changes: Array<{
  id: string
  collection: string
  recordId: string | number
  type: "create" | "update" | "delete"
  data: Record<string, unknown> | null
  timestamp: string
}>) => void

export class WsTransport implements SyncTransport {
  readonly name = "websocket"

  readonly #config: {
    url: string
    headers: Record<string, string>
    reconnectIntervalMs: number
    maxReconnectAttempts: number
    requestTimeoutMs: number
    connectionTimeoutMs: number
  }

  #ws: WebSocket | null = null
  #connected = false
  #shouldReconnect = true
  #reconnectAttempts = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #pendingRequests: Map<string, PendingRequest> = new Map()
  #requestCounter = 0
  #onServerPush: ServerPushCallback | null = null
  #connectResolve: (() => void) | null = null
  #connectReject: ((error: Error) => void) | null = null
  #connectionTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: WsTransportConfig) {
    this.#config = {
      url: config.url,
      headers: config.headers ?? {},
      reconnectIntervalMs: config.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
      connectionTimeoutMs: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT,
    }
  }

  // ── Lifecycle ──

  async connect(): Promise<void> {
    this.#shouldReconnect = true
    await this.#open()
  }

  async disconnect(): Promise<void> {
    this.#shouldReconnect = false
    this.#cancelReconnect()
    this.#clearConnectionTimer()
    this.#rejectAllPending(new Error("WebSocket disconnected"))
    this.#onServerPush = null

    if (this.#ws) {
      this.#ws.onopen = null
      this.#ws.onmessage = null
      this.#ws.onclose = null
      this.#ws.onerror = null
      this.#ws.close()
      this.#ws = null
    }

    this.#connected = false
  }

  isConnected(): boolean {
    return this.#connected
  }

  // ── Push / Pull ──

  async push(changes: SyncChangeRecord[], options?: PushOptions): Promise<SyncPushResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason
    }

    const requestId = this.#nextRequestId()

    this.#send({
      type: "push",
      requestId,
      payload: { changes },
    })

    return await this.#waitForResponse<SyncPushResult>(requestId, options?.signal)
  }

  async pull(options?: PullOptions): Promise<SyncPullResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason
    }

    const requestId = this.#nextRequestId()

    this.#send({
      type: "pull",
      requestId,
      payload: {
        cursor: options?.cursor,
        collections: options?.collections,
        batchSize: options?.batchSize,
      },
    })

    return await this.#waitForResponse<SyncPullResult>(requestId, options?.signal)
  }

  // ── Server push (real-time) ──

  onServerPush(callback: ServerPushCallback): () => void {
    this.#onServerPush = callback
    return () => {
      if (this.#onServerPush === callback) {
        this.#onServerPush = null
      }
    }
  }

  // ── Internal: WebSocket lifecycle ──

  #open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(this.#config.url)
        this.#ws = ws

        this.#connectResolve = resolve
        this.#connectReject = reject

        this.#connectionTimer = setTimeout(() => {
          if (this.#connectReject) {
            this.#connectReject(new Error("WebSocket connection timed out"))
            this.#connectResolve = null
            this.#connectReject = null
          }
          ws.close()
        }, this.#config.connectionTimeoutMs)

        ws.onopen = () => {
          this.#clearConnectionTimer()
          this.#connected = true
          this.#reconnectAttempts = 0

          if (Object.keys(this.#config.headers).length > 0) {
            this.#sendRaw({ type: "auth", payload: this.#config.headers })
          }

          if (this.#connectResolve) {
            this.#connectResolve()
            this.#connectResolve = null
            this.#connectReject = null
          }
        }

        ws.onmessage = (event: MessageEvent) => {
          try {
            const msg: WsMessage = JSON.parse(event.data as string)
            this.#handleMessage(msg)
          } catch {
            // Malformed messages are silently ignored
          }
        }

        ws.onclose = () => {
          this.#clearConnectionTimer()
          this.#connected = false
          this.#rejectAllPending(new Error("WebSocket disconnected"))

          if (this.#connectReject) {
            this.#connectReject(new Error("WebSocket connection failed"))
            this.#connectResolve = null
            this.#connectReject = null
          }

          if (this.#shouldReconnect) {
            this.#scheduleReconnect()
          }
        }

        ws.onerror = () => {
          // onclose fires after onerror, so rejection/cleanup happens there
        }
      } catch (error) {
        reject(error as Error)
      }
    })
  }

  #send(msg: WsMessage): void {
    const ws = this.#ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `WebSocket not connected (readyState: ${ws?.readyState ?? -1})`,
      )
    }
    this.#sendRaw(msg)
  }

  #sendRaw(msg: WsMessage): void {
    this.#ws?.send(JSON.stringify(msg))
  }

  // ── Internal: Message handling ──

  #handleMessage(msg: WsMessage): void {
    if (msg.type === "server_push") {
      if (this.#onServerPush && Array.isArray(msg.payload)) {
        this.#onServerPush(msg.payload as Parameters<ServerPushCallback>[0])
      }
      return
    }

    if (msg.requestId) {
      const pending = this.#pendingRequests.get(msg.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.#pendingRequests.delete(msg.requestId)

        if (msg.type === "error") {
          const errorPayload = msg.payload as { message?: string } | undefined
          pending.reject(new Error(errorPayload?.message ?? "Unknown error"))
        } else {
          pending.resolve(msg.payload)
        }
      }
    }
  }

  // ── Internal: Request matching ──

  #waitForResponse<T>(requestId: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(requestId)
        reject(new Error(`Request timed out (${requestId})`))
      }, this.#config.requestTimeoutMs)

      const entry: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      }

      this.#pendingRequests.set(requestId, entry)

      if (signal) {
        const onAbort = () => {
          clearTimeout(timer)
          this.#pendingRequests.delete(requestId)
          reject(signal.reason)
        }

        signal.addEventListener("abort", onAbort, { once: true })
      }
    })
  }

  #nextRequestId(): string {
    this.#requestCounter++
    return `req_${this.#requestCounter}_${Date.now()}`
  }

  #rejectAllPending(error: Error): void {
    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pendingRequests.clear()
  }

  // ── Internal: Reconnection ──

  #scheduleReconnect(): void {
    if (this.#reconnectAttempts >= this.#config.maxReconnectAttempts) {
      return
    }

    this.#reconnectAttempts++
    const baseDelay = this.#config.reconnectIntervalMs
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(1.5, this.#reconnectAttempts - 1),
      MAX_BACKOFF_MS,
    )
    const jitter = exponentialDelay * (0.75 + Math.random() * 0.5)

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#open().catch(() => {
        // Reconnect failure is handled by retry logic (#scheduleReconnect or max attempts)
      })
    }, jitter)
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  #clearConnectionTimer(): void {
    if (this.#connectionTimer !== null) {
      clearTimeout(this.#connectionTimer)
      this.#connectionTimer = null
    }
  }
}
