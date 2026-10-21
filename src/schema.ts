import { SchemaError, ValidationError } from "./errors"
import type { CollectionSchema, FieldDefinition, IndexDefinition, SchemaConfig } from "./types"

export class Schema {
  readonly version: number
  readonly collections: Readonly<Record<string, CollectionSchema>>

  constructor(config: SchemaConfig) {
    if (!config || typeof config !== "object") {
      throw new SchemaError("Schema configuration must be provided as an object.")
    }

    if (
      typeof config.version !== "number" ||
      !Number.isInteger(config.version) ||
      config.version < 1
    ) {
      throw new SchemaError("Schema version must be a positive integer.")
    }

    if (
      !config.collections ||
      typeof config.collections !== "object" ||
      Object.keys(config.collections).length === 0
    ) {
      throw new SchemaError("Schema must define at least one collection.")
    }

    this.version = config.version

    // Build the effective collection map first (field-level `unique` becomes a
    // unique index), then publish it as readonly.
    const collections: Record<string, CollectionSchema> = { ...config.collections }

    for (const [name, col] of Object.entries(collections)) {
      if (!col.fields || typeof col.fields !== "object" || Object.keys(col.fields).length === 0) {
        throw new SchemaError(`Collection "${name}" must define at least one field.`)
      }

      if (col.indexes) {
        for (const idx of col.indexes) {
          if (!col.fields[idx.field]) {
            throw new SchemaError(
              `Index "${idx.field}" on collection "${name}" references a non-existent field.`,
            )
          }
        }
      }

      // A field declared `unique: true` must become a unique index: that is the
      // only mechanism the adapters enforce, so without this the declaration
      // was decorative (audit M-03).
      const fieldUnique = Object.entries(col.fields)
        .filter(([, def]) => def.unique === true)
        .map(([fieldName]) => fieldName)

      if (fieldUnique.length > 0) {
        const indexes = [...(col.indexes ?? [])]
        for (const fieldName of fieldUnique) {
          const existing = indexes.find((idx) => idx.field === fieldName)
          if (existing) {
            if (!existing.unique) {
              throw new SchemaError(
                `Field "${name}.${fieldName}" is declared unique but its index is not unique.`,
              )
            }
            continue
          }
          indexes.push({ field: fieldName, unique: true })
        }
        collections[name] = { ...col, indexes }
      }
    }

    this.collections = collections
  }

  getIndexes(collectionName: string): IndexDefinition[] {
    return this.collections[collectionName]?.indexes ?? []
  }

  getRelations(
    collectionName: string,
  ): Record<string, import("./types").RelationDefinition> | undefined {
    return this.collections[collectionName]?.relations
  }

  getSearchableFields(collectionName: string): string[] {
    return this.collections[collectionName]?.searchable ?? []
  }

  applyDefaults(collectionName: string, data: Record<string, unknown>): Record<string, unknown> {
    const fields = this.collections[collectionName]?.fields
    if (!fields) return data

    const result: Record<string, unknown> = { ...data }

    for (const [fieldName, def] of Object.entries(fields)) {
      if (result[fieldName] === undefined && def.default !== undefined) {
        result[fieldName] = typeof def.default === "function" ? def.default() : def.default
      }
    }

    return result
  }

  validate(collectionName: string, data: Record<string, unknown>): void {
    const fieldDefs = this.collections[collectionName]?.fields
    if (!fieldDefs) return

    for (const [fieldName, def] of Object.entries(fieldDefs)) {
      const value = data[fieldName]

      if (def.required && (value === undefined || value === null)) {
        throw new ValidationError(collectionName, fieldName, "is required")
      }

      if (value === undefined) continue

      this.#validateType(collectionName, fieldName, value, def)

      if (def.type === "string" && typeof value === "string") {
        if (def.maxLength !== undefined && value.length > def.maxLength) {
          throw new ValidationError(
            collectionName,
            fieldName,
            `exceeds max length of ${def.maxLength} (got ${value.length} characters)`,
            value,
          )
        }
        if (def.validate === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          throw new ValidationError(
            collectionName,
            fieldName,
            "must be a valid email address",
            value,
          )
        }
        if (def.validate === "url") {
          try {
            new URL(value)
          } catch {
            throw new ValidationError(collectionName, fieldName, "must be a valid URL", value)
          }
        }
        if (def.validate instanceof RegExp && !def.validate.test(value)) {
          throw new ValidationError(collectionName, fieldName, "failed regex validation", value)
        }
        if (typeof def.validate === "function" && !def.validate(value)) {
          throw new ValidationError(collectionName, fieldName, "failed custom validation", value)
        }
      }

      if (def.type === "number" && typeof value === "number") {
        if (def.min !== undefined && value < def.min) {
          throw new ValidationError(
            collectionName,
            fieldName,
            `must be >= ${def.min} (got ${value})`,
            value,
          )
        }
        if (def.max !== undefined && value > def.max) {
          throw new ValidationError(
            collectionName,
            fieldName,
            `must be <= ${def.max} (got ${value})`,
            value,
          )
        }
      }
    }

    for (const key of Object.keys(data)) {
      if (key === "id") continue
      if (!fieldDefs[key]) {
        throw new ValidationError(collectionName, key, "is not defined in the schema", data[key])
      }
    }
  }

  #validateType(collection: string, field: string, value: unknown, def: FieldDefinition): void {
    // Explicit shape checks: `typeof value === "object"` is true for arrays,
    // null and dates, so the previous mapping accepted the wrong shapes for
    // both `object` and `array` (audit M-04).
    const describe = (input: unknown): string =>
      input === null ? "null" : Array.isArray(input) ? "array" : typeof input
    const mismatch = (): never => {
      throw new ValidationError(
        collection,
        field,
        `must be of type "${def.type}" (got "${describe(value)}")`,
        value,
      )
    }

    switch (def.type) {
      case "array":
        if (!Array.isArray(value)) mismatch()
        break

      case "object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) mismatch()
        break

      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) mismatch()
        break

      case "string":
        if (typeof value !== "string") mismatch()
        break

      case "boolean":
        if (typeof value !== "boolean") mismatch()
        break
    }

    if (def.type === "array" && Array.isArray(value) && def.items) {
      for (let i = 0; i < value.length; i++) {
        this.#validateType(collection, `${field}[${i}]`, value[i], def.items)
      }
    }
  }
}
