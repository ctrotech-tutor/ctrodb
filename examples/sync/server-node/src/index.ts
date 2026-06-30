import express from "express"
import cors from "cors"
import { createServer } from "http"
import { SyncStore } from "./store"
import { createPushHandler } from "./routes/push"
import { createPullHandler } from "./routes/pull"
import { createWsServer } from "./routes/ws"

const PORT = parseInt(process.env.PORT ?? "3000", 10)
const HOST = process.env.HOST ?? "0.0.0.0"
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*"

const app = express()
const server = createServer(app)
const store = new SyncStore()

// ── Middleware ──

app.use(cors({ origin: CORS_ORIGIN }))
app.use(express.json({ limit: "1mb" }))

// ── Routes ──

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    changeCount: store.changeCount,
  })
})

app.post("/sync/push", createPushHandler(store))
app.post("/sync/pull", createPullHandler(store))

// ── WebSocket ──

const wss = createWsServer(server, store)

// ── Server Push Example ──
// Simulate external changes being pushed to clients every 30s
// In production, this would be triggered by database changes, webhooks, etc.
const DEMO_PUSH_INTERVAL = parseInt(process.env.DEMO_PUSH_INTERVAL ?? "0", 10)

let demoInterval: ReturnType<typeof setInterval> | null = null
if (DEMO_PUSH_INTERVAL > 0) {
  demoInterval = setInterval(() => {
    const { broadcastChanges } = require("./routes/ws")
    broadcastChanges([
      {
        id: `demo_${Date.now()}`,
        collection: "_server_heartbeat",
        recordId: "heartbeat",
        type: "update",
        data: { timestamp: new Date().toISOString() },
        timestamp: new Date().toISOString(),
      },
    ])
  }, DEMO_PUSH_INTERVAL)
}

// ── Start ──

server.listen(PORT, HOST, () => {
  console.log(`[ctrodb-sync-server] Listening on ${HOST}:${PORT}`)
  console.log(`[ctrodb-sync-server] REST:  http://${HOST}:${PORT}/sync/push | /sync/pull`)
  console.log(`[ctrodb-sync-server] WS:    ws://${HOST}:${PORT}`)
  console.log(`[ctrodb-sync-server] Health: http://${HOST}:${PORT}/health`)
})

// ── Graceful Shutdown ──

function shutdown() {
  console.log("\n[ctrodb-sync-server] Shutting down...")
  if (demoInterval) {
    clearInterval(demoInterval)
    demoInterval = null
  }
  wss.close(() => {
    server.close(() => {
      console.log("[ctrodb-sync-server] Goodbye.")
      process.exit(0)
    })
  })
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
