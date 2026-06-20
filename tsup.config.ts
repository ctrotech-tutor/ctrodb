import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
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
    dts: true,
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