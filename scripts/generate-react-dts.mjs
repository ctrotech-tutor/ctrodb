/**
 * Give `ctrodb/react` a single type identity for the core.
 *
 * tsup bundles each declaration entry independently, so `dist/react/react.d.ts`
 * ends up *inlining* the whole core type graph — including `declare class
 * Database`, `declare class Collection`, `declare class QueryBuilder`, etc.
 * Classes with private members are nominal in TypeScript, so the inlined copy
 * is a different type from the one exported by `ctrodb`:
 *
 *   const db = createDatabase({ ... })   // Database from "ctrodb"
 *   <DatabaseProvider db={db} />         // expects Database from "ctrodb/react"
 *   // Type 'Database' is not assignable to type 'Database'
 *
 * This script rewrites the react declaration files so that any type the core
 * already exports is imported from the root declaration instead of being
 * redeclared. `scripts/type-smoke` then type-checks a consumer against the real
 * build output, so a regression here fails CI.
 */
import { readFileSync, writeFileSync } from "node:fs"

const DECLARATION_PATTERNS = [
  /^declare (?:class|function|const|namespace) (\w+)/,
  /^interface (\w+)/,
  /^type (\w+) =/,
]

/** Names that must stay declared here because the core does not export them. */
function exportedNames(rootDts) {
  const names = new Set()
  for (const line of rootDts.split("\n")) {
    for (const pattern of DECLARATION_PATTERNS) {
      const match = pattern.exec(line)
      if (match) names.add(match[1])
    }
  }
  return names
}

/**
 * Remove a top-level declaration starting at `startIndex`, returning the index
 * of the first line after it. Handles single-line type aliases and brace-matched
 * blocks; `declare class X` bodies are the only nested-block case here.
 */
function skipDeclaration(lines, startIndex) {
  const _first = lines[startIndex]
  let depth = 0
  let index = startIndex

  for (; index < lines.length; index++) {
    const line = lines[index]
    depth += (line.match(/{/g) ?? []).length
    depth -= (line.match(/}/g) ?? []).length
    if (depth <= 0 && (line.includes(";") || line.trimEnd().endsWith("}") || index > startIndex)) {
      if (depth <= 0 && !isContinuation(lines, index)) return index + 1
    }
  }
  return Math.min(index + 1, lines.length)
}

/** True when the declaration continues on the next line (union/intersection). */
function isContinuation(lines, index) {
  const line = lines[index].trimEnd()
  return line.endsWith("|") || line.endsWith("&") || line.endsWith(",") || line.endsWith("(")
}

function rewrite(reactPath, rootPath, importSpecifier) {
  const rootDts = readFileSync(new URL(rootPath, import.meta.url), "utf8")
  const reactDts = readFileSync(new URL(reactPath, import.meta.url), "utf8")
  const coreNames = exportedNames(rootDts)

  const lines = reactDts.split("\n")
  const removed = new Set()
  const kept = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const hit = DECLARATION_PATTERNS.map((p) => p.exec(line)).find(Boolean)
    const name = hit?.[1]

    if (name && coreNames.has(name)) {
      i = skipDeclaration(lines, i) - 1
      removed.add(name)
      continue
    }
    kept.push(line)
  }

  if (removed.size === 0) {
    throw new Error(`${reactPath}: expected to find core declarations to deduplicate`)
  }

  // Only import the core types the deduplicated file still mentions; unused
  // type imports are harmless but a precise list keeps the artifact readable.
  const body = kept.join("\n")
  const used = [...removed].filter((name) => new RegExp(`\\b${name}\\b`).test(body)).sort()

  const importLine =
    used.length > 0 ? `import type { ${used.join(", ")} } from "${importSpecifier}";\n` : ""

  writeFileSync(new URL(reactPath, import.meta.url), importLine + body.trimStart())
  console.log(`  ${reactPath}: ${removed.size} core declarations replaced by "${importSpecifier}"`)
}

rewrite("../dist/react/react.d.ts", "../dist/index.d.ts", "../index.js")
rewrite("../dist/react/react.d.cts", "../dist/index.d.cts", "../index.cjs")

// Sanity check: the public entry points must still agree on one Database type.
for (const file of ["../dist/react/react.d.ts", "../dist/react/react.d.cts"]) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8")
  if (/declare class Database\b/.test(text)) {
    throw new Error(`${file} still declares its own Database`)
  }
}
