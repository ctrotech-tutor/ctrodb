import type {
  PullOptions,
  PushOptions,
  SyncChangeRecord,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "./types"
import { validatePullResult, validatePushResult } from "./validation"

export interface HttpTransportConfig {
  url: string
  headers?: Record<string, string>
  fetchOptions?: Omit<RequestInit, "body" | "headers" | "method" | "signal">
  pullMethod?: "GET" | "POST"
  timeoutMs?: number
  pingEndpoint?: string
}

/**
 * A caller-initiated abort says nothing about the server. A timeout does: the
 * request was given its full budget and never answered.
 */
function isCallerAbort(options: { signal?: AbortSignal } | undefined): boolean {
  return options?.signal?.aborted === true
}

export class HttpTransport implements SyncTransport {
  readonly name = "http"

  readonly #config: HttpTransportConfig
  #connected = false

  constructor(config: HttpTransportConfig) {
    if (typeof fetch === "undefined") {
      throw new Error("HttpTransport requires fetch API. This environment does not support fetch.")
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
    const merged = this.#mergeSignals(options?.signal)

    try {
      const response = await fetch(`${this.#config.url}/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.#config.headers,
        },
        body: JSON.stringify({ changes }),
        signal: merged.signal,
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
      // A caller-initiated abort says nothing about the server: it used to
      // flip the transport to "disconnected" and suppress real sync attempts
      // (audit L-14).
      if (!isCallerAbort(options)) this.#connected = false
      throw error
    } finally {
      merged.dispose()
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

    const merged = this.#mergeSignals(options?.signal)

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...this.#config.headers,
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: merged.signal,
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
      if (!isCallerAbort(options)) this.#connected = false
      throw error
    } finally {
      merged.dispose()
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

  /**
   * Combine the caller's signal with the configured timeout.
   *
   * Returns a `dispose()` that the caller must invoke when the request
   * settles: the timeout timer and the abort listener are otherwise kept alive
   * for the lifetime of the caller's signal (audit L-14).
   */
  #mergeSignals(externalSignal?: AbortSignal): { signal?: AbortSignal; dispose: () => void } {
    const timeoutMs = this.#config.timeoutMs
    const noop = () => {}

    if (timeoutMs !== undefined && externalSignal === undefined) {
      return { signal: AbortSignal.timeout(timeoutMs), dispose: noop }
    }

    if (timeoutMs === undefined) {
      return { signal: externalSignal, dispose: noop }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"))
    }, timeoutMs)

    const onExternalAbort = () => {
      clearTimeout(timeoutId)
      controller.abort(externalSignal?.reason)
    }

    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timeoutId)
        externalSignal?.removeEventListener("abort", onExternalAbort)
      },
    }
  }
}
