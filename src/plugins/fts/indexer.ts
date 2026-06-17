import type { ID, StorageAdapter } from "../../types"
import { tokenize } from "./tokenizer"

const FTS_STORE = "_ctrodb_fts"

interface FtsEntry {
  id: string
  token: string
  collection: string
  docIds: ID[]
}

export class FTSIndexer {
  readonly #adapter: StorageAdapter

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter
  }

  async indexRecord(
    collection: string,
    record: Record<string, unknown>,
    searchableFields: string[],
  ): Promise<void> {
    const tokens = this.#extractTokens(record, searchableFields)
    if (tokens.length === 0) return

    for (const token of tokens) {
      const indexKey = `${collection}:${token}`
      const existing = (await this.#adapter.findById(FTS_STORE, indexKey)) as FtsEntry | null

      if (existing) {
        if (!existing.docIds.includes(record.id as ID)) {
          existing.docIds.push(record.id as ID)
          await this.#adapter.update(FTS_STORE, indexKey, { docIds: existing.docIds })
        }
      } else {
        await this.#adapter.create(FTS_STORE, {
          id: indexKey,
          token,
          collection,
          docIds: [record.id],
        })
      }
    }
  }

  async removeRecord(
    collection: string,
    record: Record<string, unknown>,
    searchableFields: string[],
  ): Promise<void> {
    const tokens = this.#extractTokens(record, searchableFields)

    for (const token of tokens) {
      const indexKey = `${collection}:${token}`
      const existing = (await this.#adapter.findById(FTS_STORE, indexKey)) as FtsEntry | null

      if (existing) {
        existing.docIds = existing.docIds.filter((id: ID) => id !== record.id)
        if (existing.docIds.length > 0) {
          await this.#adapter.update(FTS_STORE, indexKey, { docIds: existing.docIds })
        } else {
          await this.#adapter.delete(FTS_STORE, indexKey)
        }
      }
    }
  }

  async updateRecord(
    collection: string,
    oldRecord: Record<string, unknown>,
    newRecord: Record<string, unknown>,
    searchableFields: string[],
  ): Promise<void> {
    const oldTokens = this.#extractTokens(oldRecord, searchableFields)
    const newTokens = this.#extractTokens(newRecord, searchableFields)

    const tokensToRemove = oldTokens.filter((t) => !newTokens.includes(t))
    const tokensToAdd = newTokens.filter((t) => !oldTokens.includes(t))

    for (const token of tokensToRemove) {
      const indexKey = `${collection}:${token}`
      const existing = (await this.#adapter.findById(FTS_STORE, indexKey)) as FtsEntry | null
      if (existing) {
        existing.docIds = existing.docIds.filter((id: ID) => id !== newRecord.id)
        if (existing.docIds.length > 0) {
          await this.#adapter.update(FTS_STORE, indexKey, { docIds: existing.docIds })
        } else {
          await this.#adapter.delete(FTS_STORE, indexKey)
        }
      }
    }

    for (const token of tokensToAdd) {
      const indexKey = `${collection}:${token}`
      const existing = (await this.#adapter.findById(FTS_STORE, indexKey)) as FtsEntry | null
      if (existing) {
        if (!existing.docIds.includes(newRecord.id as ID)) {
          existing.docIds.push(newRecord.id as ID)
          await this.#adapter.update(FTS_STORE, indexKey, { docIds: existing.docIds })
        }
      } else {
        await this.#adapter.create(FTS_STORE, {
          id: indexKey,
          token,
          collection,
          docIds: [newRecord.id],
        })
      }
    }
  }

  async search(collection: string, query: string): Promise<ID[]> {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    const docIdSets: Set<ID>[] = []
    for (const token of tokens) {
      const indexKey = `${collection}:${token}`
      const entry = (await this.#adapter.findById(FTS_STORE, indexKey)) as FtsEntry | null
      docIdSets.push(new Set(entry?.docIds ?? []))
    }

    const [first, ...rest] = docIdSets
    if (!first) return []

    return [...first].filter((id) => rest.every((set) => set.has(id)))
  }

  #extractTokens(record: Record<string, unknown>, searchableFields: string[]): string[] {
    const allTokens = new Set<string>()
    for (const field of searchableFields) {
      const value = record[field]
      if (typeof value === "string") {
        const tokens = tokenize(value)
        for (const t of tokens) allTokens.add(t)
      }
    }
    return [...allTokens]
  }
}
