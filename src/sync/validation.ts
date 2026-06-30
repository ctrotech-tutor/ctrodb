import type { SyncPullResult, SyncPushResult } from "./types"

export class SyncResponseValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SyncResponseValidationError"
  }
}

export function validatePushResult(result: unknown): SyncPushResult {
  if (!result || typeof result !== "object") {
    throw new SyncResponseValidationError("Push result must be an object")
  }

  const r = result as Record<string, unknown>

  if (!Array.isArray(r.accepted)) {
    throw new SyncResponseValidationError("Push result missing 'accepted' array")
  }
  if (!Array.isArray(r.conflicts)) {
    throw new SyncResponseValidationError("Push result missing 'conflicts' array")
  }
  if (!Array.isArray(r.errors)) {
    throw new SyncResponseValidationError("Push result missing 'errors' array")
  }

  for (const item of r.accepted) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).id !== "string"
    ) {
      throw new SyncResponseValidationError("Each 'accepted' entry must have a string 'id'")
    }
  }

  for (const item of r.conflicts) {
    if (!item || typeof item !== "object") {
      throw new SyncResponseValidationError("Each 'conflicts' entry must be an object")
    }
    const c = item as Record<string, unknown>
    if (typeof c.changeId !== "string") {
      throw new SyncResponseValidationError("Each 'conflicts' entry must have a string 'changeId'")
    }
  }

  for (const item of r.errors) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Record<string, unknown>).id !== "string"
    ) {
      throw new SyncResponseValidationError("Each 'errors' entry must have a string 'id'")
    }
  }

  return result as SyncPushResult
}

export function validatePullResult(result: unknown): SyncPullResult {
  if (!result || typeof result !== "object") {
    throw new SyncResponseValidationError("Pull result must be an object")
  }

  const r = result as Record<string, unknown>

  if (!Array.isArray(r.changes)) {
    throw new SyncResponseValidationError("Pull result missing 'changes' array")
  }

  for (const item of r.changes) {
    if (!item || typeof item !== "object") {
      throw new SyncResponseValidationError("Each 'changes' entry must be an object")
    }
    const change = item as Record<string, unknown>
    if (typeof change.id !== "string" && typeof change.id !== "number") {
      throw new SyncResponseValidationError("Each 'changes' entry must have an 'id' field")
    }
    if (typeof change.collection !== "string") {
      throw new SyncResponseValidationError("Each 'changes' entry must have a string 'collection'")
    }
    if (typeof change.type !== "string") {
      throw new SyncResponseValidationError("Each 'changes' entry must have a string 'type'")
    }
  }

  return result as SyncPullResult
}
