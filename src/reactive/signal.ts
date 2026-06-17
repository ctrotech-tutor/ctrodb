export class Signal<T> {
  #value: T
  #subscribers = new Set<(value: T) => void>()

  constructor(initialValue: T) {
    this.#value = initialValue
  }

  get value(): T {
    return this.#value
  }

  set value(next: T) {
    if (Object.is(this.#value, next)) return
    this.#value = next
    this.#notify()
  }

  subscribe(fn: (value: T) => void): () => void {
    this.#subscribers.add(fn)
    return () => {
      this.#subscribers.delete(fn)
    }
  }

  #notify(): void {
    for (const fn of [...this.#subscribers]) {
      try {
        fn(this.#value)
      } catch (error) {
        console.error("[ctrodb] Signal subscriber error:", error)
      }
    }
  }
}
