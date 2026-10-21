import { Database } from "../../dist/index.mjs"

const ROWS = Number(new URLSearchParams(location.search).get("rows")) || 500
const ROUNDS = Number(new URLSearchParams(location.search).get("rounds")) || 5
const INDEX_COUNTS = [0, 1, 4, 8]
const CARDINALITIES = [...new Set([10, ROWS])]
const FIELD_COUNT = 8

function makeSchema(indexCount) {
  const fields = Object.fromEntries(
    Array.from({ length: FIELD_COUNT }, (_, i) => [`f${i}`, { type: "number" }]),
  )
  const indexes = Array.from({ length: indexCount }, (_, i) => ({ field: `f${i}` }))
  return {
    version: 1,
    collections: { docs: { fields, indexes } },
  }
}

function makeRecord(prefix, i, cardinality) {
  const record = { id: `${prefix}-${i}` }
  for (let field = 0; field < FIELD_COUNT; field++) {
    record[`f${field}`] = (i + field) % cardinality
  }
  return record
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function timed(fn) {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

async function runRound(indexCount, cardinality, round) {
  const name = `ctrodb-native-write-${crypto.randomUUID()}`
  const db = new Database({ name, adapter: "indexeddb", schema: makeSchema(indexCount) })

  try {
    await db.connect()
    const docs = db.collection("docs")
    const rows = Array.from({ length: ROWS }, (_, i) => makeRecord(`r${round}`, i, cardinality))

    // Single writes each open and commit their own native IndexedDB transaction.
    const createSingleMs = await timed(async () => {
      for (const row of rows) await docs.create(row)
    })

    // Batch writes exercise createMany's one-transaction path with the same
    // indexed fields and values as the sequential-create case.
    const createBatchMs = await timed(async () => {
      await docs.createMany(rows.map((row) => ({ ...row, id: `batch-${row.id}` })))
    })

    // Create an isolated set for updates, outside the measured update windows.
    const updateRows = Array.from({ length: ROWS }, (_, i) =>
      makeRecord(`update-${round}`, i, cardinality),
    )
    await docs.createMany(updateRows)

    // Collection.update() performs its normal read/validation/write/event path.
    const updateSingleFieldMs = await timed(async () => {
      for (let i = 0; i < ROWS; i++) {
        await docs.update(`update-${round}-${i}`, { f0: (i + 1) % cardinality })
      }
    })

    // Same user-visible updates in one real readwrite transaction: this isolates
    // per-transaction setup while preserving schema and change-pipeline behavior.
    const updateTransactionMs = await timed(async () => {
      await db.transaction(async (tx) => {
        const collection = tx.collection("docs")
        for (let i = 0; i < ROWS; i++) {
          await collection.update(`update-${round}-${i}`, { f0: (i + 2) % cardinality })
        }
      })
    })

    // Change each indexed key rather than just one field, to expose the native
    // secondary-index maintenance fanout as the configured index count rises.
    const updateAllIndexedFieldsMs = await timed(async () => {
      await db.transaction(async (tx) => {
        const collection = tx.collection("docs")
        for (let i = 0; i < ROWS; i++) {
          const changed = Object.fromEntries(
            Array.from({ length: indexCount }, (_, field) => [
              `f${field}`,
              (i + 3 + field) % cardinality,
            ]),
          )
          await collection.update(`update-${round}-${i}`, changed)
        }
      })
    })

    const storedRows = await docs.count()
    if (storedRows !== 3 * ROWS)
      throw new Error(`expected ${3 * ROWS} stored rows, got ${storedRows}`)

    return {
      indexCount,
      cardinality,
      round,
      rows: ROWS,
      createSingleMs,
      createBatchMs,
      updateSingleFieldMs,
      updateTransactionMs,
      updateAllIndexedFieldsMs,
      storedRows,
    }
  } finally {
    await db.disconnect()
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(`database deletion blocked: ${name}`))
    })
  }
}

window.runBenchmark = async () => {
  const samples = []
  for (const cardinality of CARDINALITIES) {
    for (const indexCount of INDEX_COUNTS) {
      for (let round = 0; round < ROUNDS; round++) {
        samples.push(await runRound(indexCount, cardinality, round))
      }
    }
  }

  const results = CARDINALITIES.flatMap((cardinality) =>
    INDEX_COUNTS.map((indexCount) => {
      const group = samples.filter(
        (sample) => sample.indexCount === indexCount && sample.cardinality === cardinality,
      )
      const medianMs = (key) => median(group.map((sample) => sample[key]))
      return {
        indexCount,
        cardinality,
        rows: ROWS,
        createSingleMs: medianMs("createSingleMs"),
        createBatchMs: medianMs("createBatchMs"),
        updateSingleFieldMs: medianMs("updateSingleFieldMs"),
        updateTransactionMs: medianMs("updateTransactionMs"),
        updateAllIndexedFieldsMs: medianMs("updateAllIndexedFieldsMs"),
        batchCreateSpeedup: medianMs("createSingleMs") / medianMs("createBatchMs"),
        transactionUpdateSpeedup: medianMs("updateSingleFieldMs") / medianMs("updateTransactionMs"),
      }
    }),
  )

  return {
    metadata: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      rowsPerCase: ROWS,
      rounds: ROUNDS,
      cardinalities: CARDINALITIES,
      note: "Chromium-native IndexedDB; timings are observational, no pass/fail speed thresholds.",
    },
    results,
    samples,
  }
}
