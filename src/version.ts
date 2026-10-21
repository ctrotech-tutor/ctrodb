/**
 * The library version.
 *
 * Injected at build time from `package.json` (see `tsup.config.ts` and
 * `vitest.config.ts`) so the published runtime constant can never drift from
 * the published package version.
 */
declare const __CTRODB_VERSION__: string | undefined

export const VERSION: string =
  typeof __CTRODB_VERSION__ === "string" ? __CTRODB_VERSION__ : "0.0.0-dev"
