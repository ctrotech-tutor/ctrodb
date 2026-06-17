# Publish Plan — ctrodb v1.0.0

## 1. Prerequisites

```bash
# Ensure you're logged into npm
npm whoami

# If not logged in:
npm login
```

## 2. Pre-Publish Verification

Run these checks in order:

```bash
npm run typecheck     # TypeScript — 0 errors
npm run lint          # Biome lint — 0 errors
npm test              # Vitest — 173 tests pass
npm run build         # tsup — ESM, CJS, IIFE all build successfully
```

## 3. Review What Ships

Preview exactly which files will be published:

```bash
npm pack --dry-run
```

Expected output (based on `"files": ["dist", "README.md", "LICENSE"]` in package.json):

```
ctrodb-1.0.0.tgz
package.json
README.md
LICENSE
dist/index.js
dist/index.mjs
dist/index.cjs
dist/index.global.js
dist/index.d.ts
dist/index.d.mts
dist/index.d.cts
dist/react/index.js
dist/react/index.mjs
dist/react/index.cjs
dist/react/index.d.ts
dist/react/index.d.mts
dist/react/index.d.cts
```

## 4. Publish

```bash
npm publish
```

This publishes as `latest` (stable) since version is `1.0.0` (no pre-release tag).

## 5. Verify Published Package

```bash
# Check the package is on npm
npm view ctrodb versions --json
npm view ctrodb

# Test installing from a temp directory
cd /tmp
mkdir ctrodb-test && cd ctrodb-test
npm init -y
npm install ctrodb
node -e "const ctrodb = require('ctrodb'); console.log(Object.keys(ctrodb))"
```

## 6. Post-Publish

```bash
# Push the v1.0.0 tag (already created locally)
git push origin v1.0.0

# Create a GitHub Release for v1.0.0
gh release create v1.0.0 \
  --title "v1.0.0" \
  --notes "Full changelog: https://github.com/ctrotech-tutor/ctrodb/blob/main/CHANGELOG.md"
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm publish` fails — package name taken | Check if `ctrodb` is already taken on npm. If so, consider `@ctrotech/ctrodb` |
| `npm publish` fails — not logged in | Run `npm login` |
| Version already published | Bump version in `package.json` (patch: `npm version patch`) |
| CI fails | Fix the issue, commit, tag again from the fix commit |

## Rollback (if needed)

```bash
# Deprecate a broken version (doesn't remove it, but warns users)
npm deprecate ctrodb@"1.0.0" "Critical bug found — use 1.0.1 instead"

# Unpublish (only works within 72 hours of publish)
npm unpublish ctrodb@1.0.0
```
