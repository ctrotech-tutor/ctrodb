import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs", "iife"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: true,
    globalName: "CtroDB",
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
  },
])
