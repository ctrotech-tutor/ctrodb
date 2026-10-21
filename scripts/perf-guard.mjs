/**
 * Performance regression guard.
 *
 * `npm run bench` reports numbers for humans; nothing in CI failed when an
 * index made queries *slower* than a scan (the memory adapter shipped that way
 * for a while: 4.97 ms vs 1.88 ms on 20k rows). Thresholds here are deliberately
 * loose — they are ratios and floors, not benchmarks, so a shared CI runner
 * cannot flake them, but a return of that class of regression fails the build.
 */
import { Database, ftsPlugin } from "../dist/index.mjs"

const ROWS = 5_000

const schema = {
  version: 1,
  collections: {
    items: {
      fields: { name: { type: "string" }, score: { type: "number" } },
      indexes: [{ field: "score" }],
    },
    scanItems: {
      fields: { name: { type: "string" }, score: { type: "number" } },
    },
    plainWrites: {
      fields: { email: { type: "string" }, name: { type: "string" } },
    },
    uniqueWrites: {
      fields: { email: { type: "string" }, name: { type: "string" } },
      indexes: [{ field: "email", unique: true }],
    },
  },
}

function percentile(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function time(fn, runs) {
  // Warm up so the first JIT pass is not measured.
  for (let i = 0; i < 20; i++) await fn()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  return percentile(samples)
}

const db = new Database({ name: `perf-guard-${Math.random()}`, adapter: "memory", schema })
await db.connect()

const items = db.collection("items")
const scanItems = db.collection("scanItems")
for (let i = 0; i < ROWS; i++) {
  const record = { id: `id-${i}`, name: `name ${i}`, score: i }
  await items.create(record)
  await scanItems.create(record)
}

const indexed = await time(
  () =>
    items
      .query()
      .where("score", "==", ROWS - 1)
      .fetch(),
  100,
)
const scanned = await time(
  () =>
    items
      .query()
      .where("name", "==", `name ${ROWS - 1}`)
      .fetch(),
  100,
)
const counted = await time(() => items.count(), 500)

// A unique index should be an O(1) membership lookup, not a scan of every row
// for each create. The old memory path made 8k unique creates 24x slower than
// ordinary creates by repeatedly traversing the entire collection.
const plainWrites = db.collection("plainWrites")
const uniqueWrites = db.collection("uniqueWrites")
const UNIQUE_ROWS = 3_000
for (let i = 0; i < 100; i++) {
  await plainWrites.create({ id: `warm-${i}`, email: `warm-${i}@example.com`, name: "warm" })
  await uniqueWrites.create({ id: `warm-${i}`, email: `warm-${i}@example.com`, name: "warm" })
}
const createLoop = async (collection, prefix) => {
  for (let i = 0; i < UNIQUE_ROWS; i++) {
    await collection.create({
      id: `${prefix}-${i}`,
      email: `${prefix}-${i}@example.com`,
      name: "write guard",
    })
  }
}
const plainWriteStart = performance.now()
await createLoop(plainWrites, "plain")
const plainWriteMs = performance.now() - plainWriteStart
const uniqueWriteStart = performance.now()
await createLoop(uniqueWrites, "unique")
const uniqueWriteMs = performance.now() - uniqueWriteStart

// A selective range must seek into sorted index keys, not visit every distinct
// key (the previous Map walk made even a one-row range as slow as a full scan).
const rangeIndexed = await time(
  () =>
    items
      .query()
      .where("score", ">=", ROWS - 1)
      .fetch(),
  100,
)
const rangeScanned = await time(
  () =>
    scanItems
      .query()
      .where("score", ">=", ROWS - 1)
      .fetch(),
  100,
)

await db.disconnect()

// Full-text indexing must stay linear in the number of documents. The old
// posting-array layout made it quadratic: 8,000 documents took ~4 s. At 6,000
// documents the current implementation needs ~0.2 s, while the old layout needed
// ~2.2 s, so the budget catches a return to quadratic behaviour while leaving
// room for a slow, shared CI runner.
const docsSchema = {
  version: 1,
  collections: {
    docs: {
      fields: { title: { type: "string" }, body: { type: "string" } },
      searchable: ["title", "body"],
    },
  },
}

const FTS_ROWS = 6_000
const ftsDb = new Database({
  name: `perf-guard-fts-${Math.random()}`,
  adapter: "memory",
  schema: docsSchema,
  plugins: [ftsPlugin()],
})
await ftsDb.connect()

const ftsStart = performance.now()
for (let i = 0; i < FTS_ROWS; i++) {
  await ftsDb.collection("docs").create({
    title: `title ${i}`,
    body: `the quick brown fox jumps over the lazy dog uniq${i}`,
  })
}
const ftsMs = performance.now() - ftsStart

// `match()` must be answered by the index: same one-hit query, indexed vs scanned.
const scanDb = new Database({
  name: `perf-guard-scan-${Math.random()}`,
  adapter: "memory",
  schema: docsSchema,
})
await scanDb.connect()
for (let i = 0; i < FTS_ROWS; i++) {
  await scanDb.collection("docs").create({
    title: `title ${i}`,
    body: `the quick brown fox jumps over the lazy dog uniq${i}`,
  })
}

const matchQuery = "uniq5999"
const matchIndexed = await time(
  () => ftsDb.collection("docs").query().match(matchQuery).fetch(),
  50,
)
const matchScanned = await time(
  () => scanDb.collection("docs").query().match(matchQuery).fetch(),
  50,
)

await ftsDb.disconnect()
await scanDb.disconnect()

const ratio = scanned / indexed
const rangeRatio = rangeScanned / rangeIndexed
const uniqueWriteRatio = uniqueWriteMs / plainWriteMs
const failures = []

if (ratio < 3) {
  failures.push(
    `indexed lookup is only ${ratio.toFixed(2)}x faster than a full scan (expected >= 3x); ` +
      "an index that does not accelerate reads is the regression this guards against",
  )
}

const matchRatio = matchScanned / matchIndexed
if (uniqueWriteRatio > 5) {
  failures.push(
    `unique-index creates are ${uniqueWriteRatio.toFixed(1)}x slower than ordinary creates (expected <= 5x); ` +
      "unique membership must use the index rather than rescanning all existing rows",
  )
}

if (rangeRatio < 3) {
  failures.push(
    `selective indexed range is only ${rangeRatio.toFixed(1)}x faster than a scan (expected >= 3x); ` +
      "range lookup must seek to matching keys instead of walking the whole index",
  )
}

if (matchRatio < 5) {
  failures.push(
    `indexed match() is only ${matchRatio.toFixed(1)}x faster than a scan (expected >= 5x); ` +
      "the full-text index is not being used",
  )
}

if (counted > 0.1) {
  failures.push(
    `count() took ${counted.toFixed(4)} ms on ${ROWS} rows (budget 0.1 ms); ` +
      "counting must not materialise the collection",
  )
}

const FTS_BUDGET_MS = 900

if (ftsMs > FTS_BUDGET_MS) {
  failures.push(
    `indexing ${FTS_ROWS} documents took ${ftsMs.toFixed(0)} ms (budget ${FTS_BUDGET_MS} ms); ` +
      "index maintenance must stay linear in the number of documents",
  )
}

console.log(`rows: ${ROWS}`)
console.log(`  indexed equality : ${indexed.toFixed(4)} ms`)
console.log(
  `  selective range  : ${rangeIndexed.toFixed(4)} ms indexed | ${rangeScanned.toFixed(4)} ms scan (${rangeRatio.toFixed(0)}x)`,
)
console.log(`  full scan        : ${scanned.toFixed(4)} ms  (${ratio.toFixed(1)}x slower)`)
console.log(`  count()          : ${counted.toFixed(4)} ms`)
console.log(
  `  unique creates   : ${uniqueWriteMs.toFixed(1)} ms unique | ${plainWriteMs.toFixed(1)} ms plain (${uniqueWriteRatio.toFixed(1)}x)`,
)
console.log(`  fts index ${FTS_ROWS} docs: ${ftsMs.toFixed(0)} ms`)
console.log(
  `  match (1 hit)    : ${matchIndexed.toFixed(4)} ms indexed | ${matchScanned.toFixed(4)} ms scanned (${matchRatio.toFixed(0)}x)`,
)

if (failures.length > 0) {
  console.error("\nPerformance guard failed:")
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log("\nPerformance guard passed.")
