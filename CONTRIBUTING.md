# Contributing to ctrodb

We love contributions! Here's how you can help.

## Code of Conduct

By participating, you agree to maintain a respectful and inclusive environment for everyone.

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates.
2. Open an issue with a clear title, steps to reproduce, expected vs actual behavior.
3. Include environment details (browser/Node version, ctrodb version).

### Suggesting Features

1. Open an issue describing the feature, use case, and ideally a proposed API.
2. Label it `enhancement`.

### Pull Requests

1. Fork the repo and create a branch from `main`.
2. Follow the existing code style (Biome enforced).
3. Write tests for new functionality.
4. Ensure all checks pass:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
npm test            # vitest run
npm run build       # tsup
```

5. Keep PRs focused — one feature/fix per PR.
6. Update documentation if needed.

### Development Setup

```bash
git clone https://github.com/ctrotech-tutor/ctrodb.git
cd ctrodb
npm install
```

## Project Conventions

- **TypeScript** — Strict mode, no `any` in source (tests may cast).
- **No runtime dependencies** — Zero-dep policy for core + plugins.
- **Biome** — Linting and formatting. Run `npm run lint -- --write` before committing.
- **Vitest** — Unit tests in `tests/unit/`. Run `npm test` for the full suite.
- **tsup** — Builds ESM, CJS, and IIFE. Run `npm run build`.

## Commit Message Style

```
type(scope): description

Types: feat, fix, chore, docs, test, refactor, style
Scopes: core, schema, query, adapter, model, plugin, react, docs

Examples:
  feat(schema): add array field validation
  fix(query): handle empty condition groups
  docs: add migration guide
```

## Release Process

Maintainers handle versioning following semver. Tags are created as `vX.Y.Z-alpha.N` during development.
