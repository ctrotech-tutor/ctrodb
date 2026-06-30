import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest"
import { Database } from "../../../src/database"
import { SyncEngine } from "../../../src/sync/sync-engine"
import { ChangeTracker } from "../../../src/sync/change-tracker"
import type {
  SyncChangeRecord,
  SyncPluginConfig,
  SyncPullResult,
  SyncPushResult,
  SyncTransport,
} from "../../../src/sync/types"

// ── Mock BroadcastChannel ──

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []

  readonly name: string
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage = vi.fn()
  close = vi.fn()

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }

  _receiveMessage(data: unknown): void {
    this.onmessage?.({ data })
  }
}

// ── Mock Transport ──

class MockTransport implements SyncTransport {
  readonly name = "mock"
  pushResult: SyncPushResult = { accepted: [], conflicts: [], errors: [] }
  pullResult: SyncPullResult = { changes: [], cursor: null, hasMore: false }
  pushCallCount = 0
  pullCallCount = 0

  async push(): Promise<SyncPushResult> {
    this.pushCallCount++
    return this.pushResult
  }

  async pull(): Promise<SyncPullResult> {
    this.pullCallCount++
    return this.pullResult
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return true
  }
}

// ── Mock window (for online/offline) ──

type MockWindow = {
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function makeMockWindow(): MockWindow {
  return {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

// ── Helpers ──

function makeEngine(
  overrides: Partial<SyncPluginConfig> & { transport?: SyncTransport } = {},
): { engine: SyncEngine; db: Database; transport: MockTransport } {
  const transport = (overrides.transport ?? new MockTransport()) as MockTransport
  const db = new Database({ adapter: "memory" })
  const config: SyncPluginConfig = {
    transport,
    autoSync: false,
    ...overrides,
  }
  const engine = new SyncEngine(db, config)
  return { engine, db, transport }
}

// ── Tests ──

describe("BroadcastChannel — ChangeTracker", () => {
  let mockWindow: MockWindow

  beforeEach(() => {
    MockBroadcastChannel.instances = []
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("broadcasts a change message after appending a change", async () => {
    const adapter = new (await import("../../../src/adapter/memory")).MemoryAdapter()
    const tracker = new ChangeTracker(adapter)

    await tracker.append("create", "todos", "rec-1", { title: "Hello" })

    expect(MockBroadcastChannel.instances.length).toBeGreaterThanOrEqual(1)
    const channel = MockBroadcastChannel.instances[0]
    expect(channel!.name).toBe("ctrodb:sync")
    expect(channel!.postMessage).toHaveBeenCalledWith({
      type: "change",
      collection: "todos",
      recordId: "rec-1",
      changeType: "create",
    })
    expect(channel!.close).toHaveBeenCalled()
  })

  it("broadcasts for update changes", async () => {
    const adapter = new (await import("../../../src/adapter/memory")).MemoryAdapter()
    const tracker = new ChangeTracker(adapter)

    await tracker.append("update", "users", "u-1", { name: "Updated" }, { name: "Original" })

    const channel = MockBroadcastChannel.instances[0]
    expect(channel!.postMessage).toHaveBeenCalledWith({
      type: "change",
      collection: "users",
      recordId: "u-1",
      changeType: "update",
    })
  })

  it("broadcasts for delete changes", async () => {
    const adapter = new (await import("../../../src/adapter/memory")).MemoryAdapter()
    const tracker = new ChangeTracker(adapter)

    await tracker.append("delete", "items", "item-1", null)

    const channel = MockBroadcastChannel.instances[0]
    expect(channel!.postMessage).toHaveBeenCalledWith({
      type: "change",
      collection: "items",
      recordId: "item-1",
      changeType: "delete",
    })
  })

  it("broadcasts with the correct message type field", async () => {
    const adapter = new (await import("../../../src/adapter/memory")).MemoryAdapter()
    const tracker = new ChangeTracker(adapter)

    await tracker.append("create", "test", "t-1", {})

    const channel = MockBroadcastChannel.instances[0]
    const msg = channel!.postMessage.mock.calls[0][0]
    expect(msg.type).toBe("change")
  })
})

describe("BroadcastChannel — SyncEngine subscription", () => {
  let mockWindow: MockWindow

  beforeEach(() => {
    MockBroadcastChannel.instances = []
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("creates a BroadcastChannel in init", async () => {
    const { engine } = makeEngine({ autoSync: true })
    expect(MockBroadcastChannel.instances.length).toBe(0)

    await engine.init()

    expect(MockBroadcastChannel.instances.length).toBe(1)
    const channel = MockBroadcastChannel.instances[0]
    expect(channel!.name).toBe("ctrodb:sync")

    await engine.destroy()
  })

  it("responds to broadcast change by emitting events and calling _emit", async () => {
    const { engine, db, transport } = makeEngine({ autoSync: true })
    await engine.init()

    const channel = MockBroadcastChannel.instances[0]
    expect(channel!.onmessage).not.toBeNull()

    const emitSpy = vi.spyOn(db, "_emit")
    const syncSpy = vi.spyOn(engine, "sync")

    channel!._receiveMessage({
      type: "change",
      collection: "todos",
      recordId: "rec-1",
      changeType: "update",
    })

    // _emit should have been called with change event
    expect(emitSpy).toHaveBeenCalledWith({
      type: "update",
      collection: "todos",
      recordId: "rec-1",
    })

    // triggerSync should have been called (autoSync is true)
    expect(syncSpy).not.toHaveBeenCalled() // debounced, not immediate

    // After debounce delay, sync should fire
    await new Promise((r) => setTimeout(r, 600))
    expect(syncSpy).toHaveBeenCalled()

    emitSpy.mockRestore()
    syncSpy.mockRestore()
    await engine.destroy()
  })

  it("ignores non-change messages", async () => {
    const { engine, db } = makeEngine({ autoSync: true })
    await engine.init()

    const channel = MockBroadcastChannel.instances[0]
    const emitSpy = vi.spyOn(db, "_emit")
    const syncSpy = vi.spyOn(engine, "sync")

    channel!._receiveMessage({ type: "ping" })
    channel!._receiveMessage({ data: 42 })
    channel!._receiveMessage(null)

    expect(emitSpy).not.toHaveBeenCalled()
    expect(syncSpy).not.toHaveBeenCalled()

    emitSpy.mockRestore()
    syncSpy.mockRestore()
    await engine.destroy()
  })

  it("triggers sync from broadcast when autoSync is enabled", async () => {
    const { engine } = makeEngine({ autoSync: { debounceMs: 50 } })
    await engine.init()

    const channel = MockBroadcastChannel.instances[0]
    const syncSpy = vi.spyOn(engine, "sync")

    channel!._receiveMessage({
      type: "change",
      collection: "todos",
      recordId: "rec-1",
      changeType: "create",
    })

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 100))

    expect(syncSpy).toHaveBeenCalled()

    syncSpy.mockRestore()
    await engine.destroy()
  })

  it("does not trigger sync from broadcast when autoSync is disabled", async () => {
    const { engine } = makeEngine({ autoSync: false })
    await engine.init()

    const channel = MockBroadcastChannel.instances[0]
    const syncSpy = vi.spyOn(engine, "sync")

    channel!._receiveMessage({
      type: "change",
      collection: "todos",
      recordId: "rec-1",
      changeType: "delete",
    })

    await new Promise((r) => setTimeout(r, 100))

    // triggerSync should be a no-op when autoSync is disabled
    expect(syncSpy).not.toHaveBeenCalled()

    syncSpy.mockRestore()
    await engine.destroy()
  })
})

describe("BroadcastChannel — cleanup on destroy", () => {
  beforeEach(() => {
    MockBroadcastChannel.instances = []
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("closes and nullifies the broadcast channel on destroy", async () => {
    const { engine } = makeEngine()
    await engine.init()

    const channel = MockBroadcastChannel.instances[0]

    await engine.destroy()

    expect(channel!.onmessage).toBeNull()
    expect(channel!.close).toHaveBeenCalled()
  })

  it("gracefully handles destroy when init was not called (no BroadcastChannel)", async () => {
    const { engine } = makeEngine()

    // No init called — BroadcastChannel should not exist
    await expect(engine.destroy()).resolves.toBeUndefined()
  })
})

describe("online/offline detection", () => {
  let mockWindow: MockWindow

  beforeEach(() => {
    mockWindow = makeMockWindow()
    vi.stubGlobal("window", mockWindow)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("registers online and offline event listeners on init", async () => {
    const { engine } = makeEngine()
    await engine.init()

    expect(mockWindow.addEventListener).toHaveBeenCalledWith("online", expect.any(Function))
    expect(mockWindow.addEventListener).toHaveBeenCalledWith("offline", expect.any(Function))

    await engine.destroy()
  })

  it("removes event listeners on destroy", async () => {
    const { engine } = makeEngine()
    await engine.init()

    await engine.destroy()

    expect(mockWindow.removeEventListener).toHaveBeenCalledWith("online", expect.any(Function))
    expect(mockWindow.removeEventListener).toHaveBeenCalledWith("offline", expect.any(Function))
  })

  it("registers an online handler that calls setConnected(true)", async () => {
    const { engine, transport } = makeEngine()
    transport.connected = false
    engine.setConnected(false)
    await engine.init()

    // Find the online handler
    const onlineCall = mockWindow.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === "online",
    )
    const onlineHandler = onlineCall?.[1] as () => void

    onlineHandler()

    expect(engine.status.isConnected).toBe(true)

    await engine.destroy()
  })

  it("registers an offline handler that calls setConnected(false)", async () => {
    const { engine } = makeEngine()
    engine.setConnected(true)
    await engine.init()

    // Find the offline handler
    const offlineCall = mockWindow.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === "offline",
    )
    const offlineHandler = offlineCall?.[1] as () => void

    offlineHandler()

    expect(engine.status.isConnected).toBe(false)

    await engine.destroy()
  })

  it("online handler calls setConnected(true)", async () => {
    const { engine } = makeEngine({ autoSync: true })
    engine.setConnected(false)
    await engine.init()

    const setConnectedSpy = vi.spyOn(engine, "setConnected")

    // Find and call the online handler
    const onlineCall = mockWindow.addEventListener.mock.calls.find(
      (c: unknown[]) => c[0] === "online",
    )
    const onlineHandler = onlineCall?.[1] as () => void
    onlineHandler()

    expect(setConnectedSpy).toHaveBeenCalledWith(true)

    setConnectedSpy.mockRestore()
    await engine.destroy()
  })

  it("handles online/offline without window globally (Node.js env)", async () => {
    vi.unstubAllGlobals() // Remove window mock

    const { engine } = makeEngine()

    // Should not throw despite window being undefined
    await expect(engine.init()).resolves.toBeUndefined()
    await engine.destroy()
  })
})
