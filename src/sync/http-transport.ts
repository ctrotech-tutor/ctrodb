import type {
  PullOptions,
  PushOptions,
  SyncChangeRecord,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "./types"
import {
  validatePullResult,
  validatePushResult,
} from "./validation"

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
    if (typeof fetch === "undefined") {
      throw new Error(
        "HttpTransport requires fetch API. This environment does not support fetch.",
      )
    }
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

    try {
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

      if (response.status === 429) {
        const retryAfter = this.#parseRetryAfter(response)
        const text = await response.text().catch(() => "Unknown error")
        const err = new Error(`Sync push rate limited (429): ${text}`)
        ;(err as unknown as Record<string, unknown>).retryAfter = retryAfter
        throw err
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error")
        throw new Error(`Sync push failed (${response.status}): ${text}`)
      }

      const data = await response.json()
      return validatePushResult(data)
    } catch (error) {
      this.#connected = false
      throw error
    }
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

    try {
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

      if (response.status === 429) {
        const retryAfter = this.#parseRetryAfter(response)
        const text = await response.text().catch(() => "Unknown error")
        const err = new Error(`Sync pull rate limited (429): ${text}`)
        ;(err as unknown as Record<string, unknown>).retryAfter = retryAfter
        throw err
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error")
        throw new Error(`Sync pull failed (${response.status}): ${text}`)
      }

      const data = await response.json()
      return validatePullResult(data)
    } catch (error) {
      this.#connected = false
      throw error
    }
  }

  #parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get("Retry-After")
    if (!header) return undefined

    const seconds = Number(header)
    if (!Number.isNaN(seconds)) return seconds * 1000

    const date = new Date(header).getTime()
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())

    return undefined
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
