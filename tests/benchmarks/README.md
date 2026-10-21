# Benchmarks

This directory contains performance benchmarks for ctrodb.

## Running Benchmarks

```bash
# Run all benchmarks
npx vitest bench

# Run a specific benchmark
npx vitest bench tests/benchmarks/query.bench.ts
```

## Native browser IndexedDB writes

The `Browser write benchmark` workflow runs real Chromium IndexedDB (not
`fake-indexeddb`) and reports median timings by index count and key cardinality.
It compares per-record `create()` with `createMany()`, one-field updates through
the normal API with updates grouped inside `db.transaction()`, and transaction
updates that change every indexed field. The workflow is manual so normal CI does
not pay the Chromium download/runtime cost; run it from **Actions → Browser write
benchmark → Run workflow**. The raw JSON samples are retained as a downloadable
artifact, and the result table is added to the workflow summary.

Locally, after installing Chromium with `npx playwright install chromium`, run:

```bash
npm run bench:browser
BROWSER_BENCH_ROWS=1000 BROWSER_BENCH_ROUNDS=5 npm run bench:browser
```

The default is 500 rows, 5 rounds, index counts 0/1/4/8, and key cardinalities
10 and 500. Timings are exploratory; this workflow intentionally has no
pass/fail speed thresholds. The browser and its storage implementation are part
of the measurement environment, so record the Chromium version with any
comparison.

## Guidelines

- Use `vitest bench` (not `vitest run`) for benchmark files.
- Each benchmark should test a single operation (create, query, scan, etc.).
- Test across different data sizes (100, 1,000, 10,000 records).
- Compare MemoryAdapter vs IndexedDBAdapter performance.
- Report results in operations/second (ops/s) with 95% confidence intervals.

## Future Benchmarks

- [ ] Query planner performance (index scan vs full scan)
- [ ] Bulk insert throughput
- [ ] FTS index build time
- [ ] Transaction overhead
- [ ] Memory usage under load
