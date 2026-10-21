/**
 * Performance baselines for the hot paths.
 *
 * `npm run bench` must always work — it previously failed with "No benchmark
 * files found", so there was no way to detect a regression in query or write
 * throughput.
 *
 * Run: npm run bench [-- tests/benchmarks/core.bench.ts]
 */
import { bench, describe } from "vitest"
import { Database } from "../../src/database"

const SIZE = 10_000

const schema = {
  version: 1,
  collections: {
    items: {
      fields: {
        name: { type: "string" },
        group: { type: "string" },
        score: { type: "number" },
        ordinal: { type: "number" },
      },
      indexes: [{ field: "group" }, { field: "score" }, { field: "ordinal" }],
    },
    scanItems: {
      fields: {
        name: { type: "string" },
        group: { type: "string" },
        score: { type: "number" },
        ordinal: { type: "number" },
      },
    },
  },
} as const

async function seeded(): Promise<Database> {
  const db = new Database({
    name: `bench-${Math.random()}`,
    adapter: "memory",
    schema: schema as never,
  })
  await db.connect()
  const items = db.collection("items")
  const scanItems = db.collection("scanItems")
  await Promise.all(
    Array.from({ length: SIZE }, async (_, i) => {
      const record = {
        id: `item-${String(i).padStart(6, "0")}`,
        name: `name ${i}`,
        group: `g${i % 10}`,
        score: i % 100,
        ordinal: i,
      }
      await Promise.all([items.create(record), scanItems.create(record)])
    }),
  )
  return db
}

const db = await seeded()
const items = db.collection("items")
const scanItems = db.collection("scanItems")

describe("reads", () => {
  bench("get by id", async () => {
    await items.get("item-005000")
  })

  bench("count", async () => {
    await items.count()
  })

  bench("query count (unfiltered)", async () => {
    await items.query().count()
  })

  bench("query count (filtered)", async () => {
    await items.query().where("score", ">=", 90).count()
  })

  bench("index equality (score == 42)", async () => {
    await items.query().where("score", "==", 42).fetch()
  })

  bench("index range (score >= 90)", async () => {
    await items.query().where("score", ">=", 90).fetch()
  })

  bench("selective range (10 of 10k)", async () => {
    await items
      .query()
      .where("ordinal", ">=", SIZE - 10)
      .fetch()
  })

  bench("selective range scan (10 of 10k)", async () => {
    await scanItems
      .query()
      .where("ordinal", ">=", SIZE - 10)
      .fetch()
  })

  bench("broad range (50% of 10k)", async () => {
    await items
      .query()
      .where("ordinal", ">=", SIZE / 2)
      .fetch()
  })

  bench("broad range scan (50% of 10k)", async () => {
    await scanItems
      .query()
      .where("ordinal", ">=", SIZE / 2)
      .fetch()
  })

  bench("full scan with post-filter", async () => {
    await items.query().where("name", "!=", "name 9999").limit(10).fetch()
  })

  bench("paginated page (limit 20, offset 1000)", async () => {
    await items.query().limit(20).offset(1000).fetch()
  })
})

describe("writes", () => {
  let counter = 0
  bench("create", async () => {
    counter++
    await items.create({ id: `bench-${counter}`, name: "n", group: "g0", score: 1 })
  })

  bench("update", async () => {
    counter++
    const id = `item-${String(counter % SIZE).padStart(6, "0")}`
    await items.update(id, { score: counter % 100 })
  })

  bench("create x100 (loop)", async () => {
    for (let i = 0; i < 100; i++) {
      counter++
      await items.create({ id: `loop-${counter}`, name: "n", group: "g0", score: 1 })
    }
  })

  bench("createMany x100", async () => {
    const batch = Array.from({ length: 100 }, () => {
      counter++
      return { id: `batch-${counter}`, name: "n", group: "g0", score: 1 }
    })
    await items.createMany(batch)
  })
})
