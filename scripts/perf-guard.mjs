/**
 * Performance regression guard.
 *
 * `npm run bench` reports numbers for humans; nothing in CI failed when an
 * index made queries *slower* than a scan (the memory adapter shipped that way
 * for a while: 4.97 ms vs 1.88 ms on 20k rows). Thresholds here are deliberately
 * loose — they are ratios and floors, not benchmarks, so a shared CI runner
 * cannot flake them, but a return of that class of regression fails the build.
 */
import { Database } from "../dist/index.mjs"

const ROWS = 5_000

const schema = {
  version: 1,
  collections: {
    items: {
      fields: { name: { type: "string" }, score: { type: "number" } },
      indexes: [{ field: "score" }],
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
for (let i = 0; i < ROWS; i++) {
  await items.create({ id: `id-${i}`, name: `name ${i}`, score: i })
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

await db.disconnect()

const ratio = scanned / indexed
const failures = []

if (ratio < 3) {
  failures.push(
    `indexed lookup is only ${ratio.toFixed(2)}x faster than a full scan (expected >= 3x); ` +
      "an index that does not accelerate reads is the regression this guards against",
  )
}

if (counted > 0.1) {
  failures.push(
    `count() took ${counted.toFixed(4)} ms on ${ROWS} rows (budget 0.1 ms); ` +
      "counting must not materialise the collection",
  )
}

console.log(`rows: ${ROWS}`)
console.log(`  indexed equality : ${indexed.toFixed(4)} ms`)
console.log(`  full scan        : ${scanned.toFixed(4)} ms  (${ratio.toFixed(1)}x slower)`)
console.log(`  count()          : ${counted.toFixed(4)} ms`)

if (failures.length > 0) {
  console.error("\nPerformance guard failed:")
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log("\nPerformance guard passed.")
