import type { CtroDBPlugin, FieldDefinition, ID } from "../../types"

export interface ValidationRule {
  name: string
  validate(
    collection: string,
    field: string,
    value: unknown,
    data: Record<string, unknown>,
    fieldDef?: FieldDefinition,
  ): string | null
}

export class ValidationEngine {
  readonly #rules: ValidationRule[] = []
  #fieldDefs = new Map<string, Record<string, FieldDefinition>>()

  addRule(rule: ValidationRule): void {
    this.#rules.push(rule)
  }

  removeRule(name: string): void {
    const idx = this.#rules.findIndex((r) => r.name === name)
    if (idx !== -1) this.#rules.splice(idx, 1)
  }

  setFieldDefs(collection: string, fieldDefs: Record<string, FieldDefinition>): void {
    this.#fieldDefs.set(collection, fieldDefs)
  }

  validate(
    collection: string,
    field: string,
    value: unknown,
    data: Record<string, unknown>,
  ): string | null {
    const fieldDefs = this.#fieldDefs.get(collection)
    const fieldDef = fieldDefs?.[field]
    for (const rule of this.#rules) {
      const error = rule.validate(collection, field, value, data, fieldDef)
      if (error !== null) return error
    }
    return null
  }

  validateAll(collection: string, data: Record<string, unknown>, fields: string[]): string[] {
    const errors: string[] = []
    for (const field of fields) {
      const error = this.validate(collection, field, data[field], data)
      if (error !== null) errors.push(error)
    }
    return errors
  }

  validateRecord(collection: string, data: Record<string, unknown>): string[] {
    return this.validateAll(collection, data, Object.keys(data))
  }

  get rules(): readonly ValidationRule[] {
    return [...this.#rules]
  }
}

const BUILTIN_RULES: ValidationRule[] = [
  {
    name: "email",
    validate(_collection: string, field: string, value: unknown, _data: Record<string, unknown>) {
      if (
        typeof value === "string" &&
        value.includes("@") &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ) {
        return `Field "${field}" is not a valid email address. Got: "${value}".`
      }
      return null
    },
  },
  {
    name: "url",
    validate(_collection: string, field: string, value: unknown, _data: Record<string, unknown>) {
      if (
        typeof value === "string" &&
        (value.startsWith("http://") || value.startsWith("https://"))
      ) {
        try {
          new URL(value)
        } catch {
          return `Field "${field}" is not a valid URL. Got: "${value}".`
        }
      }
      return null
    },
  },
  {
    name: "noEmptyStrings",
    validate(
      _collection: string,
      field: string,
      value: unknown,
      _data: Record<string, unknown>,
      fieldDef?: FieldDefinition,
    ) {
      if (typeof value === "string" && value.trim().length === 0) {
        if (fieldDef && fieldDef.required !== true) {
          return null
        }
        return `Field "${field}" cannot be empty.`
      }
      return null
    },
  },
]

export function validationPlugin(customRules?: ValidationRule[]): CtroDBPlugin {
  const engine = new ValidationEngine()
  for (const rule of BUILTIN_RULES) engine.addRule(rule)
  if (customRules) {
    for (const rule of customRules) engine.addRule(rule)
  }

  return {
    name: "validation",
    version: "1.0.0",

    onCollectionInit(collection: unknown) {
      const col = collection as { name: string; _getSchema(): { collections: Record<string, { fields: Record<string, FieldDefinition> }> } | null }
      const schema = col._getSchema()
      if (schema) {
        const colSchema = schema.collections[col.name]
        if (colSchema?.fields) {
          engine.setFieldDefs(col.name, colSchema.fields)
        }
      }
    },

    onBeforeCreate(_collection: string, data: unknown) {
      const errors = engine.validateRecord(_collection, data as Record<string, unknown>)
      if (errors.length > 0) {
        throw new Error(`Validation failed: ${errors.join("; ")}`)
      }
      return data
    },

    onBeforeUpdate(_collection: string, _id: ID, changes: unknown) {
      if (typeof changes === "object" && changes !== null && !Array.isArray(changes)) {
        const errors = engine.validateRecord(_collection, changes as Record<string, unknown>)
        if (errors.length > 0) {
          throw new Error(`Validation failed: ${errors.join("; ")}`)
        }
      }
      return changes
    },
  } as CtroDBPlugin
}