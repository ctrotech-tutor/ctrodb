import { describe, it, expect, vi } from "vitest"
import { Signal } from "../../src/reactive/signal"

describe("Signal", () => {
  it("stores and returns the initial value", () => {
    const signal = new Signal(42)
    expect(signal.value).toBe(42)
  })

  it("updates value and notifies subscribers on set", () => {
    const signal = new Signal(0)
    const fn = vi.fn()
    signal.subscribe(fn)
    signal.value = 42
    expect(fn).toHaveBeenCalledWith(42)
  })

  it("does not notify when value is unchanged (SameValueZero)", () => {
    const signal = new Signal(42)
    const fn = vi.fn()
    signal.subscribe(fn)
    signal.value = 42
    expect(fn).not.toHaveBeenCalled()
  })

  it("does not notify NaN as unchanged", () => {
    const signal = new Signal(Number.NaN)
    const fn = vi.fn()
    signal.subscribe(fn)
    signal.value = Number.NaN
    expect(fn).not.toHaveBeenCalled()
  })

  it("returns an unsubscribe function that stops notifications", () => {
    const signal = new Signal(0)
    const fn = vi.fn()
    const unsub = signal.subscribe(fn)
    unsub()
    signal.value = 99
    expect(fn).not.toHaveBeenCalled()
  })

  it("supports multiple subscribers", () => {
    const signal = new Signal("a")
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    signal.subscribe(fn1)
    signal.subscribe(fn2)
    signal.value = "b"
    expect(fn1).toHaveBeenCalledWith("b")
    expect(fn2).toHaveBeenCalledWith("b")
  })

  it("allows subscriber to unsubscribe during notification without breaking other subscribers", () => {
    const signal = new Signal(0)
    const fn1 = vi.fn()
    const fn2 = vi.fn(() => {
      unsub2()
    })
    const fn3 = vi.fn()
    signal.subscribe(fn1)
    const unsub2 = signal.subscribe(fn2)
    signal.subscribe(fn3)
    signal.value = 1
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)
    expect(fn3).toHaveBeenCalledTimes(1)
  })

  it("does not crash when a subscriber throws", () => {
    const signal = new Signal(0)
    signal.subscribe(() => {
      throw new Error("boom")
    })
    const fn = vi.fn()
    signal.subscribe(fn)
    expect(() => {
      signal.value = 1
    }).not.toThrow()
    expect(fn).toHaveBeenCalledWith(1)
  })
})
