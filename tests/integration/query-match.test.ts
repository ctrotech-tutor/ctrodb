/**
 * `query().match()` — tokenised AND search, answered by the full-text index.
 *
 * The contract that matters is **index presence changes speed, never results**.
 * Every behavioural assertion here therefore runs twice: once with `ftsPlugin()`
 * installed (index path) and once without it (scan path), and the two must
 * agree. On top of that, the tests prove the index path is actually taken —
 * a full-text plugin that silently falls back to scanning would pass an
 * unplugged parity test forever.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Database } from "../../src/database"
import { QueryError } from "../../src/errors"
import { ftsPlugin } from "../../src/plugins/fts/index"
import type { CtroDBPlugin } from "../../src/types"

const schema = {
  version: 1,
  collections: {
    docs: {
      fields: {
        title: { type: "string" },
        body: { type: "string" },
        tag: { type: "string" },
        rank: { type: "number" },
      },
      searchable: ["title", "body"],
    },
    notes: {
      // Deliberately not searchable: `match()` must refuse rather than guess.
      fields: { text: { type: "string" } },
    },
  },
} as const

const open: Database[] = []

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
})

async function makeDb(options: { plugins?: CtroDBPlugin[] } = {}): Promise<Database> {
  const db = new Database({
    name: `match-${Math.random().toString(36).slice(2)}`,
    adapter: "memory",
    schema: schema as never,
    plugins: options.plugins,
  })
  await db.connect()
  open.push(db)
  return db
}

async function seed(db: Database): Promise<void> {
  const docs = db.collection("docs")
  await docs.create({
    title: "The Quick Brown Fox",
    body: "jumps over the lazy dog",
    tag: "a",
    rank: 1,
  })
  await docs.create({
    title: "TypeScript Handbook",
    body: "a comprehensive guide to types",
    tag: "b",
    rank: 2,
  })
  await docs.create({ title: "quickfix", body: "not related to the fox story", tag: "c", rank: 3 })
  await docs.create({
    title: "Cooking with Fire",
    body: "quick recipes for brown bread",
    tag: "a",
    rank: 4,
  })
}

const titles = (rows: Array<{ title?: string }>) => rows.map((row) => row.title).sort()

describe("match() results do not depend on the index", () => {
  it("returns the same rows with and without the full-text plugin", async () => {
    const indexed = await makeDb({ plugins: [ftsPlugin()] })
    const scanned = await makeDb()
    await seed(indexed)
    await seed(scanned)

    const cases: Array<(db: Database) => Promise<unknown>> = [
      (db) => db.collection("docs").query().match("quick").fetch(),
      (db) => db.collection("docs").query().match("quick fox").fetch(),
      (db) => db.collection("docs").query().match("brown bread").fetch(),
      (db) => db.collection("docs").query().match("quick", ["title"]).fetch(),
      (db) => db.collection("docs").query().match("brown", ["body"]).fetch(),
      (db) => db.collection("docs").query().match("quick", ["title", "body"]).fetch(),
      (db) => db.collection("docs").query().match("typescript").fetch(),
      (db) => db.collection("docs").query().match("nothing-matches-this").fetch(),
      (db) => db.collection("docs").query().match("quick").where("rank", ">", 1).fetch(),
      (db) =>
        db
          .collection("docs")
          .query()
          .match("quick")
          .orWhere((q) => q.where("tag", "==", "b"))
          .fetch(),
    ]

    for (const run of cases) {
      expect(titles(await (run(indexed) as Promise<Array<{ title?: string }>>))).toEqual(
        titles(await (run(scanned) as Promise<Array<{ title?: string }>>)),
      )
    }
  })

  it("matches whole words, not substrings", async () => {
    const db = await makeDb()
    await seed(db)
    const docs = db.collection("docs")

    // "quickfix" is a different token: substring search finds it, match does not.
    expect(titles(await docs.query().match("quick").fetch())).toEqual([
      "Cooking with Fire",
      "The Quick Brown Fox",
    ])
    // "quick" is inside "quickfix", and "brown bread" is a body field value.
    expect(titles(await docs.query().search("title", "quick").fetch())).toEqual([
      "The Quick Brown Fox",
      "quickfix",
    ])
    // The body holds the word "quick" too, which `match` sees and this does not.
    expect(titles(await docs.query().search("body", "quick").fetch())).toEqual([
      "Cooking with Fire",
    ])
  })

  it("requires every token", async () => {
    const db = await makeDb()
    await seed(db)
    const docs = db.collection("docs")

    expect(titles(await docs.query().match("quick").fetch())).toHaveLength(2)
    expect(titles(await docs.query().match("quick fox").fetch())).toEqual(["The Quick Brown Fox"])
    // Both tokens exist, but not in the same document.
    expect(await docs.query().match("typescript brot").fetch()).toEqual([])
  })

  it("ignores stop words and treats a stop-word-only query as no match", async () => {
    const db = await makeDb()
    await seed(db)
    const docs = db.collection("docs")

    // "the" is a stop word: the remaining token still has to match.
    expect(titles(await docs.query().match("the fox").fetch())).toHaveLength(2)
    expect(await docs.query().match("the and of").fetch()).toEqual([])
    expect(await docs.query().match("").fetch()).toEqual([])
  })
})

describe("match() scoping", () => {
  it("searches the declared searchable fields by default", async () => {
    const db = await makeDb()
    await seed(db)
    const docs = db.collection("docs")

    // `tag` is not searchable, so its values are never matched.
    await docs.create({ title: "unrelated", body: "unrelated", tag: "needle", rank: 9 })
    expect(await docs.query().match("needle").fetch()).toEqual([])
  })

  it("restricts to explicit fields", async () => {
    const db = await makeDb()
    await seed(db)
    const docs = db.collection("docs")

    // "brown" is in the title of one document and the body of another.
    expect(titles(await docs.query().match("brown", ["title"]).fetch())).toEqual([
      "The Quick Brown Fox",
    ])
    expect(titles(await docs.query().match("brown", ["body"]).fetch())).toEqual([
      "Cooking with Fire",
    ])
    expect(titles(await docs.query().match("brown", ["title", "body"]).fetch())).toEqual([
      "Cooking with Fire",
      "The Quick Brown Fox",
    ])
  })

  it("rejects fields the collection does not declare", async () => {
    const db = await makeDb()
    const docs = db.collection("docs")

    expect(() => docs.query().match("x", ["nope"])).toThrow(QueryError)
    expect(() => docs.query().match("x", ["nope"])).toThrow(/does not declare: nope/)
    expect(() => docs.query().match("x", ["title", "nope"])).toThrow(/does not declare: nope/)
  })

  it("rejects a collection with no searchable fields, with an actionable message", async () => {
    const db = await makeDb()
    const notes = db.collection("notes")

    expect(() => notes.query().match("anything")).toThrow(QueryError)
    expect(() => notes.query().match("anything")).toThrow(/searchable/)
    // An explicit field is allowed: it is the caller's decision, and the scan
    // path handles it.
    expect(() => notes.query().match("anything", ["text"])).not.toThrow()
  })

  it("rejects an empty field list", async () => {
    const db = await makeDb()
    expect(() => db.collection("docs").query().match("x", [])).toThrow(/at least one field/)
  })
})

describe("match() uses the index", () => {
  it("does not scan the collection when the plugin is installed", async () => {
    const db = await makeDb({ plugins: [ftsPlugin()] })
    await seed(db)
    const docs = db.collection("docs")
    const adapter = db._getAdapter()
    const findAll = vi.spyOn(adapter, "findAll")

    const rows = await docs.query().match("quick").fetch()
    expect(rows).toHaveLength(2)

    const scannedCollections = findAll.mock.calls.map(([collection]) => collection)
    expect(scannedCollections).not.toContain("docs")

    // The same query without the plugin does scan.
    const plain = await makeDb()
    await seed(plain)
    const plainFindAll = vi.spyOn(plain._getAdapter(), "findAll")
    await plain.collection("docs").query().match("quick").fetch()
    expect(plainFindAll.mock.calls.map(([collection]) => collection)).toContain("docs")
  })

  it("falls back to a scan for fields the index does not cover", async () => {
    const db = await makeDb({ plugins: [ftsPlugin()] })
    await seed(db)
    const docs = db.collection("docs")

    // `tag` is not searchable, so the posting store cannot answer for it.
    await docs.create({ title: "unrelated", body: "unrelated", tag: "needle", rank: 9 })

    const findAll = vi.spyOn(db._getAdapter(), "findAll")
    expect(titles(await docs.query().match("needle", ["tag"]).fetch())).toEqual(["unrelated"])
    expect(findAll.mock.calls.map(([collection]) => collection)).toContain("docs")
  })

  it("falls back to a scan when a plugin declines the collection", async () => {
    // A plugin that advertises the capability but cannot answer: returning
    // `undefined` must mean "scan", never "no results".
    const decliningPlugin: CtroDBPlugin = {
      name: "declining-index",
      async queryTokens() {
        return undefined
      },
    }

    const db = await makeDb({ plugins: [decliningPlugin] })
    await seed(db)

    expect(titles(await db.collection("docs").query().match("quick").fetch())).toEqual([
      "Cooking with Fire",
      "The Quick Brown Fox",
    ])
  })

  it("never returns a row the predicate rejects, even from a stale index", async () => {
    const db = await makeDb({ plugins: [ftsPlugin()] })
    await seed(db)
    const docs = db.collection("docs")

    // Inject a posting for a document id that no longer exists (what a crash
    // between the record write and the index write can leave behind).
    await db._getAdapter().create("_ctrodb_fts", {
      id: "docs\u0000ghost\u0000missing-id",
      collection: "docs",
      token: "ghost",
      docId: "missing-id",
    })

    // Candidate ids are advisory: missing rows are skipped and the predicate
    // decides the rest, so a phantom posting cannot surface a phantom row.
    expect(await docs.query().match("ghost").fetch()).toEqual([])
  })
})

describe("match() composes with the rest of the query API", () => {
  it("applies sort, limit and offset", async () => {
    const db = await makeDb({ plugins: [ftsPlugin()] })
    await seed(db)
    const docs = db.collection("docs")

    const page = await docs.query().match("quick").sort({ rank: "desc" }).limit(1).fetch()
    expect(page.map((row) => row.rank)).toEqual([4])

    const offset = await docs
      .query()
      .match("quick")
      .sort({ rank: "asc" })
      .offset(1)
      .limit(1)
      .fetch()
    expect(offset.map((row) => row.rank)).toEqual([4])
  })

  it("counts matches", async () => {
    const db = await makeDb({ plugins: [ftsPlugin()] })
    await seed(db)

    expect(await db.collection("docs").query().match("quick").count()).toBe(2)
    expect(await db.collection("docs").query().match("quick fox").count()).toBe(1)
  })

  it("combines with where and with search", async () => {
    const db = await makeDb({ plugins: [ftsPlugin()] })
    await seed(db)
    const docs = db.collection("docs")

    // Both "quick" documents carry tag "a"; `rank` separates them.
    expect(titles(await docs.query().match("quick").where("tag", "==", "a").fetch())).toEqual([
      "Cooking with Fire",
      "The Quick Brown Fox",
    ])
    expect(titles(await docs.query().match("quick").where("rank", ">", 1).fetch())).toEqual([
      "Cooking with Fire",
    ])
    expect(titles(await docs.query().match("brown").search("body", "lazy").fetch())).toEqual([
      "The Quick Brown Fox",
    ])
  })
})

describe("chained conditions", () => {
  it("applies every search() condition, not just the last", async () => {
    const db = await makeDb()
    await seed(db)
    const docs = db.collection("docs")

    // Regression: the planner kept only the final `search` condition, so this
    // returned rows matching either one.
    const rows = await docs.query().search("title", "quick").search("body", "lazy").fetch()
    expect(titles(rows)).toEqual(["The Quick Brown Fox"])
  })

  it("applies every match() condition, not just the last", async () => {
    const db = await makeDb({ plugins: [ftsPlugin()] })
    await seed(db)
    const docs = db.collection("docs")

    const rows = await docs.query().match("brown").match("fox").fetch()
    expect(titles(rows)).toEqual(["The Quick Brown Fox"])
  })
})
