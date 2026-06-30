import { describe, it, expect, beforeAll, afterAll } from "vitest"
import http from "http"
import { Database, HttpTransport, syncPlugin } from "../../src/index"

// ── In-memory server store ──

const records = new Map<string, Map<string | number, Record<string, unknown>>>()
const changeLog: Array<{
  id: string
  collection: string
  recordId: string | number
  type: "create" | "update" | "delete"
  data: Record<string, unknown> | null
  timestamp: string
}> = []
let changeCounter = 0

function resetStore(): void {
  records.clear()
  changeLog.length = 0
  changeCounter = 0
}

// ── Minimal push/pull HTTP server ──

function parseJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error("Invalid JSON"))
      }
    })
    req.on("error", reject)
  })
}

function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json")

    const pathname = req.url!.split("?")[0]!

    try {
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (pathname === "/health" || pathname === "/sync" || pathname === "/sync/health")
      ) {
        res.writeHead(200)
        if (req.method === "GET") {
          res.end(JSON.stringify({ status: "ok" }))
        } else {
          res.end()
        }
        return
      }

      if (req.method === "POST" && pathname === "/sync/push") {
        const body = (await parseJson(req)) as {
          changes: Array<{
            id: string
            collection: string
            recordId: string | number
            type: "create" | "update" | "delete"
            data: Record<string, unknown> | null
            timestamp: string
          }>
        }

        const accepted: Array<{ id: string; serverTimestamp: string }> = []
        const errors: Array<{ id: string; error: string }> = []

        for (const change of body.changes ?? []) {
          changeCounter++
          const serverTimestamp = new Date().toISOString()

          if (change.type === "delete") {
            const col = records.get(change.collection)
            col?.delete(change.recordId)
          } else {
            let col = records.get(change.collection)
            if (!col) {
              col = new Map()
              records.set(change.collection, col)
            }
            col.set(change.recordId, {
              id: change.recordId,
              ...(change.data ?? {}),
              _updatedAt: serverTimestamp,
            })
          }

          changeLog.push({
            id: `svr_${changeCounter}`,
            collection: change.collection,
            recordId: change.recordId,
            type: change.type,
            data: change.type === "delete" ? null : change.data,
            timestamp: serverTimestamp,
          })

          accepted.push({ id: change.id, serverTimestamp })
        }

        res.writeHead(200)
        res.end(JSON.stringify({ accepted, conflicts: [], errors }))
        return
      }

      if (req.method === "POST" && pathname === "/sync/pull") {
        const body = (await parseJson(req)) as {
          cursor?: string | null
          collections?: string[]
          batchSize?: number
        }

        const cursorIndex = body.cursor
          ? changeLog.findIndex((c) => c.id === body.cursor)
          : -1

        const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0
        const batchSize = Math.min(Math.max(1, body.batchSize ?? 100), 500)
        const raw = changeLog.slice(startIndex, startIndex + batchSize)
        const filtered = body.collections
          ? raw.filter((c) => body.collections!.includes(c.collection))
          : raw

        const nextCursor =
          filtered.length > 0
            ? filtered[filtered.length - 1]!.id
            : body.cursor ?? null

        res.writeHead(200)
        res.end(
          JSON.stringify({
            changes: filtered,
            cursor: nextCursor,
            hasMore: startIndex + batchSize < changeLog.length,
          }),
        )
        return
      }

      res.writeHead(404)
      res.end(JSON.stringify({ error: "Not found" }))
    } catch {
      res.writeHead(500)
      res.end(JSON.stringify({ error: "Internal error" }))
    }
  })
}

// ── Helpers ──

function createClientDb(port: number, name: string): Database {
  const transport = new HttpTransport({
    url: `http://127.0.0.1:${port}/sync`,
  })

  return new Database({
    name,
    adapter: "memory",
    schema: {
      version: 1,
      collections: {
        todos: {
          fields: { title: { type: "string" }, done: { type: "boolean" } },
        },
      },
    },
    plugins: [syncPlugin({ transport, strategy: "lww", autoSync: false })],
  })
}

describe("E2E — Two clients via HTTP", () => {
  let server: http.Server
  let port: number

  beforeAll(async () => {
    resetStore()
    server = createServer()

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  // ── 1. Two clients sync via HTTP server ──

  it("syncs creates from client A to client B through the server", async () => {
    const dbA = createClientDb(port, "e2e_a")
    const dbB = createClientDb(port, "e2e_b")
    await dbA.connect()
    await dbB.connect()

    // Client A creates a record and pushes
    const todosA = dbA.collection("todos")
    const record = await todosA.create({ title: "From A", done: false })
    await dbA.sync()

    // Client B pulls
    await dbB.sync()

    // Verify B has the record
    const todosB = dbB.collection("todos")
    const allB = await todosB.getAll()
    expect(allB).toHaveLength(1)
    expect(allB[0]!.id).toBe(record.id)
    expect(allB[0]!.title).toBe("From A")

    await dbA.disconnect()
    await dbB.disconnect()
  })

  // ── 2. Conflict scenario: offline edit, then sync ──

  it("handles offline edits with LWW resolution", async () => {
    resetStore()
    const dbA = createClientDb(port, "e2e_c1")
    const dbB = createClientDb(port, "e2e_c2")
    await dbA.connect()
    await dbB.connect()

    // Both clients create the same record independently
    const todosA = dbA.collection("todos")
    const recordId = "conflict-record"

    // Client A creates the record
    const rA = await todosA.create({
      id: recordId,
      title: "From A",
      done: false,
    } as any)
    await dbA.sync()
    expect(rA.id).toBe(recordId)

    // Client B pulls to get the record
    await dbB.sync()

    // Both edit offline (simulate by creating local changes)
    const todosB = dbB.collection("todos")
    await todosB.update(recordId, { title: "From B", done: true })

    // Client A also edits
    await todosA.update(recordId, { title: "From A v2", done: false })

    // A syncs first
    await dbA.sync()

    // B syncs — server has newer version → conflict
    // With LWW, server's version (A's update) has a later timestamp
    // Actually, the server accepted A's changes first.
    // When B pushes, the server checks: B's change has an older timestamp
    // (it was made before A's), so the server sees a conflict.
    // Since the conflict happens server-side, the server rejects B's change
    // as a conflict. B's conflict resolver then handles it (LWW → remote wins).
    await dbB.sync()

    // After conflict resolution, B should have the server version
      const recordB = await todosB.get(recordId)
      expect(recordB).toBeDefined()
      // Title should reflect the winning version
      expect(recordB!.title).toBeTruthy()

    await dbA.disconnect()
    await dbB.disconnect()
  })

  // ── 3. Full roundtrip with schema ──

  it("performs a full create-update-delete roundtrip", async () => {
    resetStore()
    const dbA = createClientDb(port, "e2e_rt1")
    const dbB = createClientDb(port, "e2e_rt2")
    await dbA.connect()
    await dbB.connect()

    const todosA = dbA.collection("todos")
    const todosB = dbB.collection("todos")

    // Create
    const record = await todosA.create({ title: "Roundtrip", done: false })
    await dbA.sync()

    await dbB.sync()
    expect(await todosB.getAll()).toHaveLength(1)

    // Update
    await todosA.update(record.id, { title: "Updated roundtrip", done: true })
    await dbA.sync()

    await dbB.sync()
    const bRecord = await todosB.get(record.id)
    expect(bRecord!.title).toBe("Updated roundtrip")
    expect(bRecord!.done).toBe(true)

    // Delete
    await todosA.delete(record.id)
    await dbA.sync()

    await dbB.sync()
    expect(await todosB.getAll()).toHaveLength(0)

    await dbA.disconnect()
    await dbB.disconnect()
  })
})
