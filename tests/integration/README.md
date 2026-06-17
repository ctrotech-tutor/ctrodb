# Integration Tests

This directory contains integration tests that verify ctrodb works correctly across multiple components.

## Scope

Integration tests verify that different modules work together correctly:

- **Schema + Adapter**: Schema validation during adapter create/update flows
- **Query + Adapter**: End-to-end query execution through adapters
- **Plugins + Database**: Full lifecycle with plugins loaded
- **React + Core**: React hook integration with database operations
- **Cross-collection**: Relations between collections (via Relations plugin)

## Running

```bash
# Run all integration tests
npx vitest run tests/integration/

# Run a specific test
npx vitest run tests/integration/query-adapter.test.ts
```

## Future Integration Tests

- [ ] Schema validation through adapter create/update
- [ ] Transaction rollback across multiple collections
- [ ] FTS index + query pipeline end-to-end
- [ ] Relations eager loading with query filters
- [ ] React hooks + mutation + re-render cycle
- [ ] MemoryAdapter ↔ IndexedDBAdapter behavior parity
- [ ] Plugin hook execution order guarantees
