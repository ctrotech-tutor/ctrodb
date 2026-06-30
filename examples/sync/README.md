# ctrodb Sync — Reference Server & Backend Guides

This directory contains reference implementations and guides for building
backends compatible with ctrodb's sync protocol.

## Contents

| Directory | Description |
|-----------|-------------|
| `server-node/` | Full-featured Node.js reference server (Express + WebSocket) |
| `server-supabase/` | Guide for integrating ctrodb with Supabase |

## Protocol Overview

ctrodb's sync engine communicates with any backend that implements this contract:

### Push (`POST /sync/push`)

The client sends local changes to the server:

```json
{
  "changes": [
    {
      "id": "uuid",
      "collection": "todos",
      "recordId": "abc-123",
      "type": "create",
      "data": { "title": "Hello", "done": false },
      "timestamp": "2026-06-30T12:00:00.000Z"
    }
  ]
}
```

The server responds with:

```json
{
  "accepted": [{ "id": "uuid", "serverTimestamp": "2026-06-30T12:00:01.000Z" }],
  "conflicts": [],
  "errors": []
}
```

### Pull (`POST /sync/pull`)

The client pulls remote changes since the last cursor:

```json
{
  "cursor": "svr_42",
  "collections": ["todos"],
  "batchSize": 100
}
```

Response:

```json
{
  "changes": [ /* ... */ ],
  "cursor": "svr_142",
  "hasMore": true
}
```

### WebSocket (`ws://host/sync`)

Same push/pull operations over a persistent connection, using a
request-response pattern with `requestId`. The server can also push
unprompted changes via `server_push` messages.

## Quick Start (Node.js Server)

```bash
cd server-node
npm install
npm run dev
```

The server starts on `http://0.0.0.0:3000` with endpoints:
- `GET /health` — health check
- `POST /sync/push` — accept local changes
- `POST /sync/pull` — return remote changes

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3000` | HTTP/WS server port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | CORS allowed origin |
| `DEMO_PUSH_INTERVAL` | `0` | Interval (ms) for simulated server pushes (0 = disabled) |
