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
    this.collections = { ...config.collections }

    for (const [name, col] of Object.entries(this.collections)) {
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
    }
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
    const allowedTypes: Record<string, string[]> = {
      string: ["string"],
      number: ["number"],
      boolean: ["boolean"],
      object: ["object"],
      array: ["object"],
    }

    const validTypes = allowedTypes[def.type]
    if (!validTypes) return

    const actualType =
      def.type === "array" ? (Array.isArray(value) ? "object" : typeof value) : typeof value

    if (!validTypes.includes(actualType)) {
      throw new ValidationError(
        collection,
        field,
        `must be of type "${def.type}" (got "${typeof value}")`,
        value,
      )
    }

    if (def.type === "array" && Array.isArray(value) && def.items) {
      for (let i = 0; i < value.length; i++) {
        this.#validateType(collection, `${field}[${i}]`, value[i], def.items)
      }
    }
  }
}
