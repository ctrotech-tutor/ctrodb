/**
 * Full-text index: correctness under concurrency, and the cost of maintaining it.
 *
 * The previous index stored one record per token with a `docIds` array. Every
 * write read that array, mutated it and wrote it back, which made indexing
 * quadratic (8k documents took 4.0 s) and — worse — lost entries whenever two
 * writes overlapped: 50 concurrent `create()` calls left **1** of 50 documents
 * indexed, and two concurrent writes to the same token could throw
 * `Record "docs:common" already exists`.
 *
 * The index now stores one record per (collection, token, document) posting, so
 * a write is a single independent `create`, a delete is a single `delete`, and
 * neither reads the index. These tests pin both halves of that:
 *
 * - nothing is lost when writes interleave (every adapter),
 * - the number of adapter operations per write does not depend on index size.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { IndexedDBAdapter } from "../../src/adapter/idb"
import { MemoryAdapter } from "../../src/adapter/memory"
import { Database } from "../../src/database"
import { ftsPlugin } from "../../src/plugins/fts/index"
import { FTS_STORE, FTSIndexer } from "../../src/plugins/fts/indexer"
import type { SchemaConfig, StorageAdapter } from "../../src/types"

const FTS_FORMAT_KEY = "_ctrodb_fts_format"

const schema = {
  version: 1,
  collections: {
    docs: {
      fields: { title: { type: "string" }, body: { type: "string" } },
      searchable: ["title", "body"],
    },
    notes: {
      fields: { title: { type: "string" } },
      searchable: ["title"],
    },
  },
} as const

const open: Database[] = []

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
})

async function makeDb(
  adapter: "memory" | "indexeddb",
  extra: Partial<{ adapterInstance: StorageAdapter }> = {},
) {
  const db = new Database({
    name: `fts-${adapter}-${Math.random().toString(36).slice(2)}`,
    adapter: extra.adapterInstance ?? adapter,
    schema: schema as never,
    plugins: [ftsPlugin()],
  })
  await db.connect()
  open.push(db)
  return db
}

describe.each(["memory", "indexeddb"] as const)("full-text index (%s)", (adapterName) => {
  it("indexes every document when writes interleave", async () => {
    const db = await makeDb(adapterName)
    const docs = db.collection("docs")
    const indexer = new FTSIndexer(db._getAdapter())

    // Every document shares the token "shared", so all of these writes target
    // the same posting bucket. Before the fix this lost all but one entry.
    const count = 50
    await Promise.all(
      Array.from({ length: count }, (_, i) => docs.create({ title: `doc ${i}`, body: "shared" })),
    )

    expect(await docs.count()).toBe(count)
    expect(await indexer.tokenSize("docs", "shared")).toBe(count)
    expect(await indexer.search("docs", "shared")).toHaveLength(count)
  })

  it("keeps posting writes independent of how large the index is", async () => {
    const db = await makeDb(adapterName)
    const docs = db.collection("docs")
    const adapter = db._getAdapter()

    // A write must not read the index to append to it: that read is what made
    // indexing quadratic and what raced between concurrent callers.
    const findById = vi.spyOn(adapter, "findById")
    const findAll = vi.spyOn(adapter, "findAll")

    const count = 20
    for (let i = 0; i < count; i++) {
      await docs.create({ title: "alpha beta", body: "gamma" })
    }

    const ftsReads = [...findById.mock.calls, ...findAll.mock.calls].filter(
      ([collection]) => collection === FTS_STORE,
    )
    expect(ftsReads).toEqual([])

    // Two tokens from `title`, one from `body`, for each document.
    const postings = await adapter.findAll(FTS_STORE)
    expect(postings).toHaveLength(count * 3)
  })

  it("moves postings when a document is updated", async () => {
    const db = await makeDb(adapterName)
    const docs = db.collection("docs")
    const indexer = new FTSIndexer(db._getAdapter())

    const doc = await docs.create({ title: "Original Title", body: "" })
    expect(await indexer.search("docs", "original")).toEqual([doc.id])

    await docs.update(doc.id, { title: "Updated Title" })

    expect(await indexer.search("docs", "original")).toEqual([])
    expect(await indexer.search("docs", "updated")).toEqual([doc.id])
    // The unchanged token stays put.
    expect(await indexer.search("docs", "title")).toEqual([doc.id])
  })

  it("removes postings when a document is deleted", async () => {
    const db = await makeDb(adapterName)
    const docs = db.collection("docs")
    const indexer = new FTSIndexer(db._getAdapter())

    const doc = await docs.create({ title: "Deletable", body: "" })
    await docs.delete(doc.id)

    expect(await indexer.search("docs", "deletable")).toEqual([])
    expect(await adapterPostings(db)).toHaveLength(0)
  })

  it("requires every query token and keeps collections apart", async () => {
    const db = await makeDb(adapterName)
    const docs = db.collection("docs")
    const notes = db.collection("notes")
    const indexer = new FTSIndexer(db._getAdapter())

    const both = await docs.create({ title: "quick brown", body: "fox" })
    await docs.create({ title: "quick red", body: "" })
    await notes.create({ title: "quick brown" })

    expect(await indexer.search("docs", "quick brown")).toEqual([both.id])
    expect(await indexer.search("docs", "quick")).not.toContain(expect.anything())
    expect((await indexer.search("docs", "quick")).length).toBe(2)
    expect((await indexer.search("notes", "quick")).length).toBe(1)
  })

  it("re-indexing the same document is a no-op", async () => {
    const db = await makeDb(adapterName)
    const indexer = new FTSIndexer(db._getAdapter())

    const record = { id: "fixed", title: "stable", body: "" }
    await indexer.indexRecord("docs", record, ["title", "body"])
    await indexer.indexRecord("docs", record, ["title", "body"])

    expect(await indexer.tokenSize("docs", "stable")).toBe(1)
  })
})

describe("full-text index without a declared index", () => {
  it("still searches, by scanning the posting store", async () => {
    // Direct construction over an adapter connected without a schema: the store
    // has no `token` index, so `hasIndex` is false and search falls back.
    const adapter = new MemoryAdapter()
    await adapter.connect("fts-no-index", null)
    const indexer = new FTSIndexer(adapter)

    await indexer.indexRecord("docs", { id: "a", title: "hello world" }, ["title"])
    await indexer.indexRecord("docs", { id: "b", title: "goodbye world" }, ["title"])

    expect(adapter.hasIndex(FTS_STORE, "token")).toBe(false)
    expect(await indexer.search("docs", "hello")).toEqual(["a"])
    expect((await indexer.search("docs", "world")).sort()).toEqual(["a", "b"])

    await adapter.disconnect()
  })
})

describe("full-text index migration", () => {
  it("rebuilds a legacy postings store on connect", async () => {
    const dbName = `fts-migrate-${Math.random().toString(36).slice(2)}`
    const schemaConfig: SchemaConfig = {
      version: 1,
      collections: schema.collections as unknown as SchemaConfig["collections"],
      pluginStoreNames: [
        { name: FTS_STORE, indexes: [{ field: "token" }, { field: "collection" }] },
      ],
    }

    // Seed a database that still holds the format-1 layout.
    const seed = new IndexedDBAdapter()
    await seed.connect(dbName, schemaConfig)
    await seed.create("docs", { id: "d1", title: "legacy alpha", body: "" })
    await seed.create("docs", { id: "d2", title: "legacy beta", body: "" })
    await seed.create(FTS_STORE, {
      id: "docs:legacy",
      token: "legacy",
      collection: "docs",
      docIds: ["d1", "d2"],
    })
    await seed.setMetadata(FTS_FORMAT_KEY, 1)
    await seed.disconnect()

    const db = new Database({
      name: dbName,
      adapter: "indexeddb",
      schema: schema as never,
      plugins: [ftsPlugin()],
    })
    await db.connect()
    open.push(db)

    const indexer = new FTSIndexer(db._getAdapter())

    // The legacy records are gone and the postings were rebuilt from the rows.
    const postings = await adapterPostings(db)
    expect(postings.every((record) => (record as { docId?: unknown }).docId !== undefined)).toBe(
      true,
    )
    expect(await indexer.search("docs", "legacy").then((ids) => ids.sort())).toEqual(["d1", "d2"])
    expect((await indexer.search("docs", "alpha")).length).toBe(1)
    expect(await db._getAdapter().getMetadata(FTS_FORMAT_KEY)).toBe(2)
  })

  it("does not rebuild when the store is already current", async () => {
    const db = await makeDb("memory")
    const docs = db.collection("docs")
    await docs.create({ title: "current format", body: "" })

    const indexer = new FTSIndexer(db._getAdapter())
    expect(await indexer.search("docs", "current")).toHaveLength(1)
    expect(await db._getAdapter().getMetadata(FTS_FORMAT_KEY)).toBe(2)
  })
})

async function adapterPostings(db: Database): Promise<unknown[]> {
  return db._getAdapter().findAll(FTS_STORE)
}
