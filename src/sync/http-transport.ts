import type {
  PullOptions,
  PushOptions,
  SyncChangeRecord,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "./types"

export interface HttpTransportConfig {
  url: string
  headers?: Record<string, string>
  fetchOptions?: Omit<RequestInit, "body" | "headers" | "method" | "signal">
  pullMethod?: "GET" | "POST"
  timeoutMs?: number
  pingEndpoint?: string
}

export class HttpTransport implements SyncTransport {
  readonly name = "http"

  readonly #config: HttpTransportConfig
  #connected = false

  constructor(config: HttpTransportConfig) {
    this.#config = config
  }

  async connect(): Promise<void> {
    const baseUrl = this.#config.url.replace(/\/+$/, "")
    const pingEndpoint = this.#config.pingEndpoint ?? ""
    const url = pingEndpoint ? `${baseUrl}/${pingEndpoint.replace(/^\/+/, "")}` : baseUrl

    const response = await fetch(url, {
      method: "HEAD",
      ...this.#config.fetchOptions,
    })

    if (!response.ok) {
      throw new Error(`Sync server unreachable (${response.status})`)
    }

    this.#connected = true
  }

  disconnect(): Promise<void> {
    this.#connected = false
    return Promise.resolve()
  }

  isConnected(): boolean {
    return this.#connected
  }

  async push(changes: SyncChangeRecord[], options?: PushOptions): Promise<SyncPushResult> {
    const signal = this.#mergeSignals(options?.signal)

    const response = await fetch(`${this.#config.url}/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.#config.headers,
      },
      body: JSON.stringify({ changes }),
      signal,
      ...this.#config.fetchOptions,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error")
      throw new Error(`Sync push failed (${response.status}): ${text}`)
    }

    return response.json() as Promise<SyncPushResult>
  }

  async pull(options?: PullOptions): Promise<SyncPullResult> {
    const method = this.#config.pullMethod ?? "POST"
    const baseUrl = this.#config.url.replace(/\/+$/, "")

    const params: string[] = []

    const body: Record<string, unknown> = {}
    if (options?.cursor) {
      params.push(`cursor=${encodeURIComponent(options.cursor)}`)
      body.cursor = options.cursor
    }
    if (options?.collections && options.collections.length > 0) {
      body.collections = options.collections
    }
    if (options?.batchSize) {
      body.batchSize = options.batchSize
    }

    const url = params.length > 0 ? `${baseUrl}/pull?${params.join("&")}` : `${baseUrl}/pull`

    const signal = this.#mergeSignals(options?.signal)

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...this.#config.headers,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal,
      ...this.#config.fetchOptions,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "Unknown error")
      throw new Error(`Sync pull failed (${response.status}): ${text}`)
    }

    return response.json() as Promise<SyncPullResult>
  }

  #mergeSignals(externalSignal?: AbortSignal): AbortSignal | undefined {
    const timeoutMs = this.#config.timeoutMs

    if (timeoutMs !== undefined && externalSignal === undefined) {
      return AbortSignal.timeout(timeoutMs)
    }

    if (timeoutMs === undefined) {
      return externalSignal
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"))
    }, timeoutMs)

    if (externalSignal !== undefined) {
      externalSignal.addEventListener("abort", () => {
        clearTimeout(timeoutId)
        controller.abort(externalSignal.reason)
      })
    }

    return controller.signal
  }
}
