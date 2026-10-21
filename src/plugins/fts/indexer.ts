import { equalityRange } from "../../query/range"
import type { ID, QueryCondition, StorageAdapter } from "../../types"
import { tokenize } from "./tokenizer"

export const FTS_STORE = "_ctrodb_fts"

/**
 * Storage format of the index, persisted under `_ctrodb_fts_format`.
 *
 * - **1** (legacy): one record per token — `${collection}:${token}` — holding
 *   every document id in a `docIds` array. Every write read the array, mutated
 *   it and wrote it back, which is quadratic in the number of documents and
 *   loses entries when two writes interleave: 50 concurrent `create()` calls
 *   left 1 of 50 documents indexed.
 * - **2**: one record per (collection, token, document) *posting*. A write is a
 *   single independent `create`/`delete`, so writes are O(tokens), idempotent
 *   and race-free, and a delete never has to read the index at all.
 */
export const FTS_FORMAT = 2

/** Field names used by the posting records; also the declared index names. */
export const FTS_INDEXED_FIELDS = ["token", "collection"] as const

/**
 * Separator inside a posting key.
 *
 * Tokens only contain `[a-z0-9]` (see `tokenize`), so only the collection name
 * and the document id could ever contain it. The id is stored in the record as
 * well and is never parsed back out of the key, so a collision could only merge
 * two documents whose ids both contain a NUL byte — which cannot be written to
 * IndexedDB keys in the first place.
 */
const SEP = "\u0000"

export interface FtsPosting {
  id: string
  collection: string
  token: string
  docId: ID
}

export function postingId(collection: string, token: string, docId: ID): string {
  return `${collection}${SEP}${token}${SEP}${docId}`
}

/** Ids sort numbers before strings, each in their natural order. */
function compareIds(a: ID, b: ID): number {
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "number") return -1
  if (typeof b === "number") return 1
  return a < b ? -1 : a > b ? 1 : 0
}

function isDuplicateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === "ConstraintError" || /already exists|unique constraint/i.test(error.message)
}

export class FTSIndexer {
  readonly #adapter: StorageAdapter
  /** Whether the posting store can be queried by token. Resolved once. */
  #tokenIndexed: boolean | undefined

  constructor(adapter: StorageAdapter) {
    this.#adapter = adapter
  }

  /**
   * Index one document.
   *
   * Each posting is an independent insert, so concurrent calls cannot clobber
   * each other and re-indexing the same document is a no-op.
   */
  async indexRecord(
    collection: string,
    record: Record<string, unknown>,
    searchableFields: string[],
  ): Promise<void> {
    const docId = record.id as ID | undefined
    if (docId === undefined) return
    await this.#addPostings(collection, docId, this.#extractTokens(record, searchableFields))
  }

  /** Remove every posting for a document: one delete per token, no reads. */
  async removeRecord(
    collection: string,
    record: Record<string, unknown>,
    searchableFields: string[],
  ): Promise<void> {
    const docId = record.id as ID | undefined
    if (docId === undefined) return

    for (const token of this.#extractTokens(record, searchableFields)) {
      await this.#adapter.delete(FTS_STORE, postingId(collection, token, docId))
    }
  }

  /**
   * Move a document's postings from its old text to its new text.
   *
   * Only the tokens that actually changed are touched, so an update of one
   * field does not rewrite the whole document's index.
   */
  async updateRecord(
    collection: string,
    oldRecord: Record<string, unknown>,
    newRecord: Record<string, unknown>,
    searchableFields: string[],
  ): Promise<void> {
    const docId = newRecord.id as ID | undefined
    if (docId === undefined) return

    const oldTokens = this.#extractTokens(oldRecord, searchableFields)
    const newTokens = this.#extractTokens(newRecord, searchableFields)

    const removed = oldTokens.filter((token) => !newTokens.includes(token))
    const added = newTokens.filter((token) => !oldTokens.includes(token))

    for (const token of removed) {
      await this.#adapter.delete(FTS_STORE, postingId(collection, token, docId))
    }
    await this.#addPostings(collection, docId, added)
  }

  /**
   * Document ids matching **every** token of `query`, in a stable order.
   *
   * Uses the `token` index when the store has one and falls back to reading the
   * postings store otherwise (an `FTSIndexer` constructed directly over an
   * adapter that was connected without a schema has no index).
   */
  async search(collection: string, query: string): Promise<ID[]> {
    const tokens = tokenize(query)
    if (tokens.length === 0) return []

    const matches: Set<ID>[] = []
    for (const token of tokens) {
      matches.push(new Set(await this.#postingsFor(collection, token)))
    }

    const [first, ...rest] = matches
    if (!first) return []

    return [...first].filter((id) => rest.every((set) => set.has(id))).sort(compareIds)
  }

  /** Indexed document count for one collection/token (used by tests and tools). */
  async tokenSize(collection: string, token: string): Promise<number> {
    return (await this.#postingsFor(collection, token)).length
  }

  /** Every posting id currently stored. Used by the migration and by tools. */
  async postingIds(): Promise<string[]> {
    const records = await this.#adapter.findAll(FTS_STORE)
    return records.map((record) => String((record as { id: unknown }).id))
  }

  async clear(): Promise<void> {
    const ids = await this.postingIds()
    if (ids.length > 0) await this.#adapter.deleteMany(FTS_STORE, ids)
  }

  async #addPostings(collection: string, docId: ID, tokens: string[]): Promise<void> {
    for (const token of tokens) {
      const posting: FtsPosting = {
        id: postingId(collection, token, docId),
        collection,
        token,
        docId,
      }

      try {
        await this.#adapter.create(FTS_STORE, posting)
      } catch (error) {
        // Already indexed. Re-indexing must be safe: the same document can be
        // written twice through a retry, a sync replay or a concurrent caller.
        if (!isDuplicateError(error)) throw error
      }
    }
  }

  async #postingsFor(collection: string, token: string): Promise<ID[]> {
    const postFilters: QueryCondition[] = [
      { type: "where", field: "collection", op: "==", value: collection },
    ]

    if (await this.#canQueryByToken()) {
      const records = await this.#adapter.scanIndex(
        FTS_STORE,
        "token",
        equalityRange(token),
        postFilters,
      )
      return records.map((record) => (record as unknown as FtsPosting).docId)
    }

    const records = await this.#adapter.findAll(FTS_STORE)
    return records
      .filter((record) => {
        const posting = record as unknown as FtsPosting
        return (
          posting.token === token &&
          posting.collection === collection &&
          posting.docId !== undefined
        )
      })
      .map((record) => (record as unknown as FtsPosting).docId)
  }

  async #canQueryByToken(): Promise<boolean> {
    if (this.#tokenIndexed === undefined) {
      this.#tokenIndexed = this.#adapter.hasIndex?.(FTS_STORE, "token") ?? false
    }
    return this.#tokenIndexed
  }

  #extractTokens(record: Record<string, unknown>, searchableFields: string[]): string[] {
    const allTokens = new Set<string>()
    for (const field of searchableFields) {
      const value = record[field]
      if (typeof value === "string") {
        for (const token of tokenize(value)) allTokens.add(token)
      }
    }
    return [...allTokens]
  }
}
