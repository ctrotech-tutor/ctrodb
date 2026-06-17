import type { StorageAdapter } from "../types"
import { IndexedDBAdapter } from "./idb"
import { MemoryAdapter } from "./memory"

export function createAdapter(type?: "indexeddb" | "memory"): StorageAdapter {
  if (type === "memory") return new MemoryAdapter()
  if (type === "indexeddb") return new IndexedDBAdapter()

  if (typeof window !== "undefined" && window.indexedDB) {
    return new IndexedDBAdapter()
  }

  return new MemoryAdapter()
}
