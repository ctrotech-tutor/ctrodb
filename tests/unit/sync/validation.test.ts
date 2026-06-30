import { describe, it, expect } from "vitest"
import {
  SyncResponseValidationError,
  validatePullResult,
  validatePushResult,
} from "../../../src/sync/validation"
import type { SyncPullResult, SyncPushResult } from "../../../src/sync/types"

// ── validatePushResult ──

describe("validatePushResult", () => {
  it("passes valid push result", () => {
    const input: SyncPushResult = {
      accepted: [{ id: "chg-1", serverTimestamp: "2026-01-01T00:00:00Z" }],
      conflicts: [],
      errors: [],
    }
    expect(validatePushResult(input)).toEqual(input)
  })

  it("passes push result with conflicts", () => {
    const input: SyncPushResult = {
      accepted: [],
      conflicts: [
        {
          changeId: "chg-1",
          recordId: "rec-1",
          collection: "todos",
          local: { title: "local" },
          remote: { title: "remote" },
          localTimestamp: "2026-01-01T00:00:00Z",
          remoteTimestamp: "2026-01-02T00:00:00Z",
          fieldConflicts: ["title"],
        },
      ],
      errors: [],
    }
    expect(validatePushResult(input)).toEqual(input)
  })

  it("passes push result with errors", () => {
    const input: SyncPushResult = {
      accepted: [],
      conflicts: [],
      errors: [{ id: "chg-1", error: "Validation failed" }],
    }
    expect(validatePushResult(input)).toEqual(input)
  })

  it("throws for null input", () => {
    expect(() => validatePushResult(null)).toThrow(SyncResponseValidationError)
  })

  it("throws for non-object input", () => {
    expect(() => validatePushResult("string")).toThrow(SyncResponseValidationError)
  })

  it("throws when accepted is missing", () => {
    expect(() => validatePushResult({ conflicts: [], errors: [] })).toThrow(
      SyncResponseValidationError,
    )
  })

  it("throws when conflicts is missing", () => {
    expect(() => validatePushResult({ accepted: [], errors: [] })).toThrow(
      SyncResponseValidationError,
    )
  })

  it("throws when errors is missing", () => {
    expect(() => validatePushResult({ accepted: [], conflicts: [] })).toThrow(
      SyncResponseValidationError,
    )
  })

  it("throws when accepted entry lacks id", () => {
    expect(() =>
      validatePushResult({
        accepted: [{ serverTimestamp: "ts" }],
        conflicts: [],
        errors: [],
      }),
    ).toThrow(SyncResponseValidationError)
  })

  it("throws when conflicts entry lacks changeId", () => {
    expect(() =>
      validatePushResult({
        accepted: [],
        conflicts: [{}],
        errors: [],
      }),
    ).toThrow(SyncResponseValidationError)
  })

  it("throws when errors entry lacks id", () => {
    expect(() =>
      validatePushResult({
        accepted: [],
        conflicts: [],
        errors: [{}],
      }),
    ).toThrow(SyncResponseValidationError)
  })
})

// ── validatePullResult ──

describe("validatePullResult", () => {
  it("passes valid pull result with changes", () => {
    const input: SyncPullResult = {
      changes: [
        {
          id: "chg-1",
          collection: "todos",
          recordId: "rec-1",
          type: "create",
          data: { title: "Hello" },
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      cursor: "cursor-abc",
      hasMore: false,
    }
    expect(validatePullResult(input)).toEqual(input)
  })

  it("passes valid pull result with empty changes", () => {
    const input: SyncPullResult = {
      changes: [],
      cursor: null,
      hasMore: false,
    }
    expect(validatePullResult(input)).toEqual(input)
  })

  it("passes pull result with hasMore true", () => {
    const input: SyncPullResult = {
      changes: [
        {
          id: "chg-1",
          collection: "todos",
          recordId: "rec-1",
          type: "update",
          data: { title: "Updated" },
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      cursor: "cursor-xyz",
      hasMore: true,
    }
    expect(validatePullResult(input)).toEqual(input)
  })

  it("throws for null input", () => {
    expect(() => validatePullResult(null)).toThrow(SyncResponseValidationError)
  })

  it("throws when changes is missing", () => {
    expect(() => validatePullResult({ cursor: null, hasMore: false })).toThrow(
      SyncResponseValidationError,
    )
  })

  it("throws when changes entry lacks id", () => {
    expect(() =>
      validatePullResult({
        changes: [{ collection: "todos", type: "create" }],
        cursor: null,
        hasMore: false,
      }),
    ).toThrow(SyncResponseValidationError)
  })

  it("throws when changes entry lacks collection", () => {
    expect(() =>
      validatePullResult({
        changes: [{ id: "chg-1", type: "create" }],
        cursor: null,
        hasMore: false,
      }),
    ).toThrow(SyncResponseValidationError)
  })

  it("throws when changes entry lacks type", () => {
    expect(() =>
      validatePullResult({
        changes: [{ id: "chg-1", collection: "todos" }],
        cursor: null,
        hasMore: false,
      }),
    ).toThrow(SyncResponseValidationError)
  })
})

// ── SyncResponseValidationError ──

describe("SyncResponseValidationError", () => {
  it("has the correct name", () => {
    const err = new SyncResponseValidationError("test error")
    expect(err.name).toBe("SyncResponseValidationError")
  })

  it("preserves the message", () => {
    const err = new SyncResponseValidationError("custom message")
    expect(err.message).toBe("custom message")
  })

  it("is an instance of Error", () => {
    const err = new SyncResponseValidationError("test")
    expect(err).toBeInstanceOf(Error)
  })
})
