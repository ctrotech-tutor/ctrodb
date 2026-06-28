import type { CtroDBPlugin } from "../../types"

export class RelationsEngine {}

export function relationsPlugin(): CtroDBPlugin {
  return {
    name: "relations",
    version: "1.0.0",
  }
}
