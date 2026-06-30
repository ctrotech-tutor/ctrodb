import type {
  ConflictResolution,
  ConflictResolverFn,
  ConflictStrategy,
  SyncConflict,
} from "./types"

export class ConflictResolverEngine {
  readonly #strategy: ConflictStrategy
  readonly #customResolver?: ConflictResolverFn

  constructor(strategy: ConflictStrategy = "lww", customResolver?: ConflictResolverFn) {
    this.#strategy = strategy
    this.#customResolver = customResolver
  }

  async resolve(conflict: SyncConflict): Promise<ConflictResolution> {
    if (this.#strategy === "custom") {
      if (!this.#customResolver) {
        throw new Error(
          "Conflict strategy set to 'custom' but no conflictResolver function provided",
        )
      }
      return this.#customResolver(conflict)
    }

    switch (this.#strategy) {
      case "client-wins":
        return { resolution: "local" }
      case "server-wins":
        return { resolution: "remote" }
      default:
        return this.#lww(conflict)
    }
  }

  #lww(conflict: SyncConflict): ConflictResolution {
    const localTs = this.#parseTimestamp(conflict.localTimestamp)
    const remoteTs = this.#parseTimestamp(conflict.remoteTimestamp)

    const localExists = conflict.local !== null
    const remoteExists = conflict.remote !== null

    if (!localExists && !remoteExists) {
      return { resolution: "remote" }
    }
    if (!localExists) {
      return { resolution: "remote" }
    }
    if (!remoteExists) {
      return { resolution: "local" }
    }

    if (localTs > remoteTs) {
      return { resolution: "local" }
    }
    if (remoteTs > localTs) {
      return { resolution: "remote" }
    }

    return { resolution: "remote" }
  }

  #parseTimestamp(ts: string): number {
    const parsed = new Date(ts).getTime()
    return Number.isNaN(parsed) ? 0 : parsed
  }
}
