import type { CtroDBPlugin } from "../types"

export async function runHook(
  plugins: CtroDBPlugin[],
  hookName: keyof CtroDBPlugin,
  ...args: unknown[]
): Promise<unknown> {
  for (const plugin of plugins) {
    const hook = plugin[hookName]
    if (typeof hook !== "function") continue

    if (hookName === "onBeforeCreate") {
      const dataIndex = 1
      const result = await (hook as (collection: string, data: unknown) => unknown)(
        args[0] as string,
        args[dataIndex],
      )
      if (result !== undefined) args[dataIndex] = result
    } else if (hookName === "onBeforeUpdate") {
      const dataIndex = 2
      const result = await (hook as (collection: string, id: unknown, changes: unknown) => unknown)(
        args[0] as string,
        args[1],
        args[dataIndex],
      )
      if (result !== undefined) args[dataIndex] = result
    } else if (hookName === "onAfterUpdate") {
      await (
        hook as (collection: string, id: unknown, record: unknown, oldRecord?: unknown) => void
      )(args[0] as string, args[1], args[2], args[3])
    } else if (hookName === "onAfterDelete") {
      await (hook as (collection: string, id: unknown, oldRecord?: unknown) => void)(
        args[0] as string,
        args[1],
        args[2],
      )
    } else if (hookName === "onAfterCreate") {
      await (hook as (collection: string, record: unknown) => void)(args[0] as string, args[1])
    } else if (hookName === "onBeforeDelete") {
      await (hook as (collection: string, id: unknown) => void)(args[0] as string, args[1])
    } else {
      await (hook as (...args: unknown[]) => unknown)(...args)
    }
  }

  if (hookName === "onBeforeCreate") return args[1]
  if (hookName === "onBeforeUpdate") return args[2]
  return undefined
}
