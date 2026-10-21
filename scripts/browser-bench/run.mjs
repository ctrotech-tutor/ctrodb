import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { extname, resolve, sep } from "node:path"
import { chromium } from "playwright"

const root = resolve(process.cwd())
function positiveInteger(name, fallback, maximum) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`)
  }
  return value
}

const rows = positiveInteger("BROWSER_BENCH_ROWS", 500, 5000)
const rounds = positiveInteger("BROWSER_BENCH_ROUNDS", 5, 20)
const outputPath =
  process.env.BROWSER_BENCH_OUT ?? resolve(tmpdir(), "ctrodb-indexeddb-benchmark.json")
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
    const filePath = resolve(root, `.${pathname}`)
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end("Forbidden")
      return
    }
    const contents = await readFile(filePath)
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    })
    response.end(contents)
  } catch {
    response.writeHead(404).end("Not found")
  }
})

await new Promise((resolveListen, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolveListen)
})

let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text())
  })

  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/scripts/browser-bench/index.html?rows=${rows}&rounds=${rounds}`
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => typeof window.runBenchmark === "function")
  const result = await page.evaluate(() => window.runBenchmark())
  if (pageErrors.length)
    throw new Error(`Browser benchmark emitted errors:\n${pageErrors.join("\n")}`)

  result.metadata.browserVersion = browser.version()
  result.metadata.nodeVersion = process.version
  result.metadata.generatedAt = new Date().toISOString()
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)

  console.log("Native IndexedDB benchmark (lower times are better; exploratory, no timing gate)")
  console.log(
    `Browser: Chromium ${result.metadata.browserVersion}; ${rows} rows/case; ${rounds} rounds; median reported`,
  )
  console.table(
    result.results.map((row) => ({
      indexes: row.indexCount,
      cardinality: row.cardinality,
      "create() ms": row.createSingleMs.toFixed(1),
      "createMany ms": row.createBatchMs.toFixed(1),
      "batch ×": row.batchCreateSpeedup.toFixed(2),
      "update one field ms": row.updateSingleFieldMs.toFixed(1),
      "update in tx ms": row.updateTransactionMs.toFixed(1),
      "tx update ×": row.transactionUpdateSpeedup.toFixed(2),
      "update all indexed fields ms": row.updateAllIndexedFieldsMs.toFixed(1),
    })),
  )
  console.log(`Raw samples: ${outputPath}`)

  if (process.env.GITHUB_STEP_SUMMARY) {
    const tableRows = result.results
      .map(
        (row) =>
          `| ${row.indexCount} | ${row.cardinality} | ${row.createSingleMs.toFixed(1)} | ${row.createBatchMs.toFixed(1)} | ${row.batchCreateSpeedup.toFixed(2)}× | ${row.updateSingleFieldMs.toFixed(1)} | ${row.updateTransactionMs.toFixed(1)} | ${row.transactionUpdateSpeedup.toFixed(2)}× | ${row.updateAllIndexedFieldsMs.toFixed(1)} |`,
      )
      .join("\n")
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Native IndexedDB write benchmark\n\n${result.metadata.browserVersion}; ${rows} rows/case; median of ${rounds} rounds. Timings are observational, not pass/fail thresholds.\n\n| Indexes | Value cardinality | create() ms | createMany ms | batch speedup | update one field ms | update in transaction ms | transaction speedup | update all indexed fields ms |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${tableRows}\n\nRaw samples are uploaded as the ctrodb-indexeddb-benchmark artifact.\n`,
      { flag: "a" },
    )
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}
