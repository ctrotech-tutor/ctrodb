# ctrodb + Supabase

Use Supabase as the backend for ctrodb sync. This guide shows you how to
implement the `SyncTransport` interface using the Supabase JS client.

## Overview

Instead of running the reference Node.js server, you can point ctrodb's sync
engine directly at Supabase. The transport translates ctrodb's push/pull
protocol into Supabase `upsert` / `select` calls.

## Database Schema

Create these tables in your Supabase project:

### `_sync_log` — ordered change log for pull cursor

```sql
create table _sync_log (
  id        bigint generated always as identity primary key,
  collection text not null,
  record_id  text not null,
  change_type text not null check (change_type in ('create', 'update', 'delete')),
  data       jsonb,
  created_at timestamptz not null default now()
);

create index idx_sync_log_created_at on _sync_log (created_at asc);
```

Each data collection table is created normally (e.g. `todos`, `users`).
There is no separate push log — pushes write directly to the data tables
and append an entry to `_sync_log`.

## Transport Implementation

```typescript
import { createClient } from "@supabase/supabase-js"
import type { SyncTransport, SyncPushResult, SyncPullResult, SyncChangeRecord } from "ctrodb"

class SupabaseTransport implements SyncTransport {
  readonly name = "supabase"
  #supabase: ReturnType<typeof createClient>

  constructor(url: string, anonKey: string) {
    this.#supabase = createClient(url, anonKey)
  }

  async push(changes: SyncChangeRecord[]): Promise<SyncPushResult> {
    const accepted: Array<{ id: string; serverTimestamp: string }> = []
    const conflicts: any[] = []
    const errors: Array<{ id: string; error: string }> = []

    for (const change of changes) {
      try {
        if (change.type === "delete") {
          const { error } = await this.#supabase
            .from(change.collection)
            .delete()
            .eq("id", change.recordId)

          if (error) {
            errors.push({ id: change.id, error: error.message })
          } else {
            accepted.push({ id: change.id, serverTimestamp: new Date().toISOString() })
          }
        } else {
          const payload = { id: change.recordId, ...change.data }
          const { error } = await this.#supabase
            .from(change.collection)
            .upsert(payload)
            .select()

          if (error) {
            errors.push({ id: change.id, error: error.message })
          } else {
            accepted.push({ id: change.id, serverTimestamp: new Date().toISOString() })
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error"
        errors.push({ id: change.id, error: message })
      }
    }

    return { accepted, conflicts, errors }
  }

  async pull(options?: { cursor?: string; collections?: string[]; batchSize?: number }): Promise<SyncPullResult> {
    const batchSize = Math.min(Math.max(1, options?.batchSize ?? 100), 500)

    let query = this.#supabase
      .from("_sync_log")
      .select("*")
      .order("id", { ascending: true })
      .limit(batchSize)

    if (options?.cursor) {
      query = query.gt("id", options.cursor)
    }

    // Supabase doesn't support array contains for IN with .in()
    // Filter in-memory if collections filter is active
    const { data, error } = await query

    if (error) throw new Error(error.message)

    let rows = (data ?? [])
    if (options?.collections && options.collections.length > 0) {
      rows = rows.filter((r: any) => options.collections!.includes(r.collection))
    }

    const changes = rows.map((row: any) => ({
      id: String(row.id),
      collection: row.collection,
      recordId: row.record_id,
      type: row.change_type,
      data: row.data,
      timestamp: row.created_at,
    }))

    return {
      changes,
      cursor: changes.length > 0 ? changes[changes.length - 1]!.id : options?.cursor ?? null,
      hasMore: (data?.length ?? 0) >= batchSize,
    }
  }
}
```

## Usage

```typescript
import { Database, syncPlugin } from "ctrodb"

const transport = new SupabaseTransport(
  "https://your-project.supabase.co",
  "your-anon-key",
)

const db = new Database({
  name: "myapp",
  adapter: "indexeddb",
  schema: {
    version: 1,
    collections: {
      todos: { fields: { title: { type: "string" }, done: { type: "boolean" } } },
    },
  },
  plugins: [
    syncPlugin({ transport, autoSync: { intervalMs: 30000 } }),
  ],
})

await db.connect()
```

## Limitations

- No conflict detection — Supabase `upsert` always overwrites. For conflict
  detection, you need a custom Edge Function or the reference Node.js server.
- No real-time push — Use Supabase Realtime subscriptions as an alternative.
- Cursor-based pagination requires the `_sync_log` table to exist.

For production use with conflict resolution, we recommend deploying the
reference Node.js server (in `examples/sync/server-node`) backed by
Supabase's PostgreSQL database.
