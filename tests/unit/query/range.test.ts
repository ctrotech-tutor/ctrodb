import { describe, expect, it } from "vitest"
import {
  compareQueryKeys,
  createQueryRange,
  equalityRange,
  isQueryKey,
  queryRangeContains,
} from "../../../src/query/range"

describe("query ranges — storage-neutral descriptors", () => {
  it("accepts only values IndexedDB can index", () => {
    expect(isQueryKey("a")).toBe(true)
    expect(isQueryKey(1)).toBe(true)
    expect(isQueryKey(new Date())).toBe(true)

    expect(isQueryKey(true)).toBe(false)
    expect(isQueryKey(false)).toBe(false)
    expect(isQueryKey(null)).toBe(false)
    expect(isQueryKey(undefined)).toBe(false)
    expect(isQueryKey({})).toBe(false)
    expect(isQueryKey([])).toBe(false)
    expect(isQueryKey(Number.NaN)).toBe(false)
    expect(isQueryKey(new Date("nope"))).toBe(false)
  })

  it("builds closed ranges for equality", () => {
    expect(createQueryRange("==", 5)).toEqual({
      lower: 5,
      upper: 5,
      lowerOpen: false,
      upperOpen: false,
    })
    expect(equalityRange("pending")).toEqual({
      lower: "pending",
      upper: "pending",
      lowerOpen: false,
      upperOpen: false,
    })
  })

  it("builds open/closed bounds for comparison operators", () => {
    expect(createQueryRange(">", 5)).toEqual({ lower: 5, lowerOpen: true, upperOpen: false })
    expect(createQueryRange(">=", 5)).toEqual({ lower: 5, lowerOpen: false, upperOpen: false })
    expect(createQueryRange("<", 5)).toEqual({ upper: 5, lowerOpen: false, upperOpen: true })
    expect(createQueryRange("<=", 5)).toEqual({ upper: 5, lowerOpen: false, upperOpen: false })
  })

  it("returns undefined for operators and values that are not contiguous keys", () => {
    // "!=" cannot be expressed as one range: callers must post-filter.
    expect(createQueryRange("!=", 5)).toBeUndefined()
    expect(createQueryRange("==", true)).toBeUndefined()
    expect(createQueryRange("==", null)).toBeUndefined()
    expect(createQueryRange("==", { nested: true })).toBeUndefined()
  })

  it("evaluates descriptors against stored values", () => {
    const range = createQueryRange(">=", 10)
    expect(range).toBeDefined()
    if (!range) return

    expect(queryRangeContains(range, 10)).toBe(true)
    expect(queryRangeContains(range, 11)).toBe(true)
    expect(queryRangeContains(range, 9)).toBe(false)

    // IndexedDB uses a total order across key types (number < date < string),
    // so a string key is "greater" than a numeric bound. Schema validation is
    // what keeps field types homogeneous.
    expect(queryRangeContains(range, "11")).toBe(true)

    // Non-key values can never satisfy a range.
    expect(queryRangeContains(range, true)).toBe(false)
    expect(queryRangeContains(range, null)).toBe(false)
    expect(queryRangeContains(range, {})).toBe(false)
  })

  it("honours open bounds", () => {
    const lowerOpen = createQueryRange(">", 10)
    expect(lowerOpen).toBeDefined()
    if (!lowerOpen) return

    expect(queryRangeContains(lowerOpen, 10)).toBe(false)
    expect(queryRangeContains(lowerOpen, 10.0001)).toBe(true)
  })

  it("compares keys using IndexedDB ordering (number < date < string)", () => {
    expect(compareQueryKeys(1, 2)).toBe(-1)
    expect(compareQueryKeys(2, 1)).toBe(1)
    expect(compareQueryKeys(1, 1)).toBe(0)
    expect(compareQueryKeys(new Date(5), new Date(10))).toBe(-1)
    expect(compareQueryKeys(Number.MAX_SAFE_INTEGER, new Date(0))).toBe(-1)
    expect(compareQueryKeys(new Date(0), "")).toBe(-1)
    expect(compareQueryKeys("a", "b")).toBe(-1)
  })

  it("supports date ranges", () => {
    const from = new Date("2026-01-01T00:00:00Z")
    const range = createQueryRange(">=", from)
    expect(range).toBeDefined()
    if (!range) return

    expect(queryRangeContains(range, new Date("2026-06-01T00:00:00Z"))).toBe(true)
    expect(queryRangeContains(range, new Date("2025-06-01T00:00:00Z"))).toBe(false)
  })
})
