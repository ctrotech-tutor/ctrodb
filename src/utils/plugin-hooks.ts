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
/**
 * Run an "after" hook without letting a plugin failure corrupt the operation.
 *
 * By the time these hooks run the write is already durable, so rejecting the
 * caller's promise would report a successful write as failed (and invite a
 * retry that duplicates it). Failures are reported to the console and, when
 * available, forwarded to `onError` so applications can observe them.
 */
export async function runAfterHook(
  plugins: CtroDBPlugin[],
  hookName: keyof CtroDBPlugin,
  args: unknown[],
  onError?: (error: Error, plugin: string) => void,
): Promise<void> {
  for (const plugin of plugins) {
    const hook = plugin[hookName]
    if (typeof hook !== "function") continue
    try {
      await runHook([plugin], hookName, ...args)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      const name = (plugin as { name?: string }).name ?? "unknown"
      if (onError) onError(normalized, name)
      else console.error(`[ctrodb] plugin "${name}" failed in ${String(hookName)}:`, normalized)
    }
  }
}

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
