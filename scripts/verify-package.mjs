/**
 * Post-build package validation.
 *
 * Fails when the published tarball would be broken for consumers:
 *  - an entry point referenced by package.json is missing from `dist/`
 *  - the runtime `VERSION` does not match `package.json`
 *  - the React bundle accidentally inlines React instead of externalising it
 *
 * Run by CI after `npm run build` (see .github/workflows/*.yml).
 */
import { existsSync, readFileSync } from "node:fs"

const failures = []

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const root = new URL("../", import.meta.url)

const requiredFiles = new Set([
  "dist/index.mjs",
  "dist/index.cjs",
  "dist/index.global.js",
  "dist/index.d.ts",
  "dist/react/react.mjs",
  "dist/react/react.cjs",
  "dist/react/react.d.ts",
])

/** Collect every file referenced by `exports`, including nested conditions. */
function collectTargets(entry) {
  if (typeof entry === "string") {
    requiredFiles.add(entry.replace(/^\.\//, ""))
    return
  }
  for (const value of Object.values(entry ?? {})) collectTargets(value)
}

for (const entry of Object.values(pkg.exports ?? {})) collectTargets(entry)
for (const versions of Object.values(pkg.typesVersions ?? {})) {
  for (const targets of Object.values(versions)) collectTargets(targets)
}

for (const file of requiredFiles) {
  if (!existsSync(new URL(file, root))) {
    failures.push(`missing build artifact: ${file}`)
  }
}

const runtime = await import(new URL("dist/index.mjs", root).href)
if (runtime.VERSION !== pkg.version) {
  failures.push(`runtime VERSION (${runtime.VERSION}) !== package.json (${pkg.version})`)
}

for (const expected of ["Database", "Collection", "syncPlugin", "MemoryAdapter"]) {
  if (!(expected in runtime)) {
    failures.push(`public entry point does not export ${expected}`)
  }
}

// The react declarations must borrow the core's types, not redeclare them:
// two `Database` classes are nominally incompatible (see scripts/generate-react-dts.mjs).
for (const file of ["dist/react/react.d.ts", "dist/react/react.d.cts"]) {
  const text = readFileSync(new URL(file, root), "utf8")
  if (/declare class (Database|Collection|Model|QueryBuilder)\b/.test(text)) {
    failures.push(`${file} redeclares a core type instead of importing it`)
  }
  if (!text.includes('from "../index')) {
    failures.push(`${file} does not import core types from ../index`)
  }
}

const reactBundle = readFileSync(new URL("dist/react/react.mjs", root), "utf8")
if (!/from\s*["']react["']/.test(reactBundle)) {
  failures.push('dist/react/react.mjs does not import from "react" (React may be bundled)')
}

if (failures.length > 0) {
  console.error("Package verification failed:")
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`Package verification passed for ${pkg.name}@${pkg.version}.`)
