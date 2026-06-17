# Benchmarks

This directory contains performance benchmarks for ctrodb.

## Running Benchmarks

```bash
# Run all benchmarks
npx vitest bench

# Run a specific benchmark
npx vitest bench tests/benchmarks/query.bench.ts
```

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
