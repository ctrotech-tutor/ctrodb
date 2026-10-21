export class CtrodbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CtrodbError"
  }
}

export class ConnectionError extends CtrodbError {
  constructor(dbName: string, reason?: string) {
    const msg = reason
      ? `Failed to connect to database "${dbName}": ${reason}`
      : `Database "${dbName}" is not connected. Call db.connect() before performing operations.`
    super(msg)
    this.name = "ConnectionError"
  }
}

export class CollectionNotFoundError extends CtrodbError {
  constructor(collectionName: string, availableCollections?: string[]) {
    let msg = `Collection "${collectionName}" not found.`
    if (availableCollections && availableCollections.length > 0) {
      msg += ` Available collections: ${availableCollections.join(", ")}`
    }
    super(msg)
    this.name = "CollectionNotFoundError"
  }
}

export class RecordNotFoundError extends CtrodbError {
  constructor(collectionName: string, id: unknown) {
    super(`Record with id "${String(id)}" not found in collection "${collectionName}".`)
    this.name = "RecordNotFoundError"
  }
}

/**
 * The browser refused a write because storage is full (IndexedDB
 * `QuotaExceededError`, or a `DOMException` with the same name).
 *
 * Previously this surfaced as a raw `DOMException` from deep inside the
 * adapter, so applications could not distinguish "you are out of space — free
 * some and retry" from a programming error (audit L-15).
 */
export class StorageQuotaError extends CtrodbError {
  constructor(detail?: string) {
    super(
      `Storage quota exceeded${detail ? `: ${detail}` : ""}. Free space (or clear ` +
        "cached data) and retry; the write was not applied.",
    )
    this.name = "StorageQuotaError"
  }
}

export class SchemaError extends CtrodbError {
  constructor(message: string) {
    super(message)
    this.name = "SchemaError"
  }
}

export class ValidationError extends CtrodbError {
  readonly field: string
  readonly collection: string
  readonly value: unknown

  constructor(collection: string, field: string, message: string, value?: unknown) {
    const valStr = value !== undefined ? ` Got: ${JSON.stringify(value)}.` : ""
    super(`Field "${field}" in collection "${collection}": ${message}.${valStr}`)
    this.name = "ValidationError"
    this.field = field
    this.collection = collection
    this.value = value
  }
}

export class QueryError extends CtrodbError {
  constructor(message: string) {
    super(message)
    this.name = "QueryError"
  }
}
