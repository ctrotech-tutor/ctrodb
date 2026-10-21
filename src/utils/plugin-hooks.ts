import type { CtroDBPlugin, WriteContext } from "../types"

/**
 * Run a plugin lifecycle hook across all plugins, in registration order.
 *
 * "Before" hooks may rewrite the payload by returning a value; "after" hooks
 * are observational. The trailing {@link WriteContext} argument tells plugins
 * whether the write came from the caller (`local`) or from the sync engine
 * (`remote`), which lets them avoid reacting to their own applied changes.
 *
 * The per-hook argument shapes are explicit so plugin implementations get
 * precise types instead of a variadic `unknown[]`.
 */
export async function runHook(
  plugins: CtroDBPlugin[],
  hookName: keyof CtroDBPlugin,
  ...args: unknown[]
): Promise<unknown> {
  const context = args[args.length - 1] as WriteContext | undefined
  const hasContext = context !== undefined && typeof context === "object" && "origin" in context

  for (const plugin of plugins) {
    const hook = plugin[hookName]
    if (typeof hook !== "function") continue

    switch (hookName) {
      case "onBeforeCreate": {
        const collection = args[0] as string
        const data = args[1]
        const result = await (hook as (c: string, d: unknown, ctx?: WriteContext) => unknown)(
          collection,
          data,
          hasContext ? context : undefined,
        )
        if (result !== undefined) args[1] = result
        break
      }

      case "onBeforeUpdate": {
        const collection = args[0] as string
        const id = args[1]
        const changes = args[2]
        const result = await (
          hook as (c: string, i: unknown, ch: unknown, ctx?: WriteContext) => unknown
        )(collection, id, changes, hasContext ? context : undefined)
        if (result !== undefined) args[2] = result
        break
      }

      case "onAfterCreate": {
        await (hook as (c: string, r: unknown, ctx?: WriteContext) => void)(
          args[0] as string,
          args[1],
          hasContext ? context : undefined,
        )
        break
      }

      case "onAfterUpdate": {
        await (
          hook as (c: string, i: unknown, r: unknown, old?: unknown, ctx?: WriteContext) => void
        )(args[0] as string, args[1], args[2], args[3], hasContext ? context : undefined)
        break
      }

      case "onBeforeDelete": {
        await (hook as (c: string, i: unknown, ctx?: WriteContext) => void)(
          args[0] as string,
          args[1],
          hasContext ? context : undefined,
        )
        break
      }

      case "onAfterDelete": {
        await (hook as (c: string, i: unknown, old?: unknown, ctx?: WriteContext) => void)(
          args[0] as string,
          args[1],
          args[2],
          hasContext ? context : undefined,
        )
        break
      }

      default: {
        await (hook as (...a: unknown[]) => unknown)(...args)
        break
      }
    }
  }

  if (hookName === "onBeforeCreate") return args[1]
  if (hookName === "onBeforeUpdate") return args[2]
  return undefined
}
