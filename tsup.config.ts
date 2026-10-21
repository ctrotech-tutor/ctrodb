import { readFileSync } from "node:fs"
import { defineConfig } from "tsup"

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string
}

/** Replaced at build time; keeps `VERSION` identical to `package.json`. */
const define = { __CTRODB_VERSION__: JSON.stringify(pkg.version) }

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    define,
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    outExtension({ format }) {
      return {
        js: format === "esm" ? ".mjs" : ".cjs",
      }
    },
  },
  {
    entry: ["src/index.ts"],
    format: ["iife"],
    define,
    globalName: "CtroDB",
    dts: false,
    sourcemap: true,
    clean: false,
    minify: true,
    outExtension() {
      return { js: ".global.js" }
    },
  },
  {
    entry: ["src/react.ts"],
    format: ["esm", "cjs"],
    define,
    dts: {
      resolve: ["react", "react-dom"],
    },
    sourcemap: true,
    clean: false,
    minify: true,
    external: ["react"],
    outDir: "dist/react",
    outExtension({ format }) {
      return {
        js: format === "esm" ? ".mjs" : ".cjs",
      }
    },
  },
])