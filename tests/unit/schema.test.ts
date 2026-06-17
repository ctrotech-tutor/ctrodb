import { describe, expect, it } from "vitest"
import { Schema } from "../../src/schema"

const validConfig = {
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string" as const, required: true },
        email: { type: "string" as const, validate: "email" as const },
        age: { type: "number" as const, min: 0, max: 150 },
        role: { type: "string" as const, default: "user" },
      },
      indexes: [{ field: "email", unique: true }, { field: "age" }],
    },
  },
}

describe("Schema", () => {
  it("creates a valid schema", () => {
    const schema = new Schema(validConfig)
    expect(schema.version).toBe(1)
    expect(schema.collections.users.fields.name.type).toBe("string")
  })

  it("throws for missing configuration", () => {
    expect(() => new Schema(undefined as any)).toThrow(
      "Schema configuration must be provided as an object.",
    )
  })

  it("throws for non-integer version", () => {
    expect(
      () => new Schema({ version: 1.5, collections: { x: { fields: { a: { type: "string" } } } } }),
    ).toThrow("Schema version must be a positive integer.")
  })

  it("throws for version 0", () => {
    expect(
      () => new Schema({ version: 0, collections: { x: { fields: { a: { type: "string" } } } } }),
    ).toThrow("Schema version must be a positive integer.")
  })

  it("throws for empty collections", () => {
    expect(() => new Schema({ version: 1, collections: {} })).toThrow(
      "Schema must define at least one collection.",
    )
  })

  it("throws for collection without fields", () => {
    expect(() => new Schema({ version: 1, collections: { x: {} as any } })).toThrow(
      'Collection "x" must define at least one field.',
    )
  })

  it("throws for index referencing non-existent field", () => {
    expect(
      () =>
        new Schema({
          version: 1,
          collections: {
            users: {
              fields: { name: { type: "string" } },
              indexes: [{ field: "nonexistent" }],
            },
          },
        }),
    ).toThrow('Index "nonexistent" on collection "users" references a non-existent field.')
  })

  describe("applyDefaults", () => {
    it("applies static default values", () => {
      const schema = new Schema({
        version: 1,
        collections: {
          items: {
            fields: {
              label: { type: "string" },
              count: { type: "number", default: 0 },
            },
          },
        },
      })
      const result = schema.applyDefaults("items", { label: "test" })
      expect(result.count).toBe(0)
    })

    it("does not override provided values", () => {
      const schema = new Schema({
        version: 1,
        collections: {
          items: {
            fields: {
              label: { type: "string", default: "default" },
            },
          },
        },
      })
      const result = schema.applyDefaults("items", { label: "custom" })
      expect(result.label).toBe("custom")
    })
  })

  describe("validate", () => {
    it("passes for valid data", () => {
      const schema = new Schema(validConfig)
      expect(() =>
        schema.validate("users", { name: "Alice", email: "a@b.com", age: 30 }),
      ).not.toThrow()
    })

    it("throws for missing required field", () => {
      const schema = new Schema(validConfig)
      expect(() => schema.validate("users", { email: "a@b.com" })).toThrow(
        'Field "name" in collection "users": is required.',
      )
    })

    it("throws for type mismatch", () => {
      const schema = new Schema(validConfig)
      expect(() => schema.validate("users", { name: "Alice", age: "old" as any })).toThrow(
        'Field "age" in collection "users": must be of type "number"',
      )
    })

    it("throws for invalid email", () => {
      const schema = new Schema(validConfig)
      expect(() => schema.validate("users", { name: "Alice", email: "not-an-email" })).toThrow(
        'Field "email" in collection "users": must be a valid email address',
      )
    })

    it("throws for number below minimum", () => {
      const schema = new Schema(validConfig)
      expect(() => schema.validate("users", { name: "Alice", age: -1 })).toThrow(
        'Field "age" in collection "users": must be >= 0',
      )
    })

    it("throws for number above maximum", () => {
      const schema = new Schema(validConfig)
      expect(() => schema.validate("users", { name: "Alice", age: 200 })).toThrow(
        'Field "age" in collection "users": must be <= 150',
      )
    })

    it("throws for unknown fields", () => {
      const schema = new Schema(validConfig)
      expect(() => schema.validate("users", { name: "Alice", unknownField: "test" })).toThrow(
        'Field "unknownField" in collection "users": is not defined in the schema',
      )
    })

    it("skips validation for undefined optional fields", () => {
      const schema = new Schema(validConfig)
      expect(() => schema.validate("users", { name: "Alice" })).not.toThrow()
    })

    it("validates url fields", () => {
      const schema = new Schema({
        version: 1,
        collections: {
          sites: {
            fields: {
              url: { type: "string", validate: "url" as const },
            },
          },
        },
      })
      expect(() => schema.validate("sites", { url: "not-a-url" })).toThrow("must be a valid URL")
      expect(() => schema.validate("sites", { url: "https://example.com" })).not.toThrow()
    })
  })

  describe("getIndexes", () => {
    it("returns indexes for a collection", () => {
      const schema = new Schema(validConfig)
      const indexes = schema.getIndexes("users")
      expect(indexes).toHaveLength(2)
      expect(indexes[0]?.field).toBe("email")
    })

    it("returns empty array for collection without indexes", () => {
      const schema = new Schema({
        version: 1,
        collections: {
          items: {
            fields: { name: { type: "string" } },
          },
        },
      })
      expect(schema.getIndexes("items")).toEqual([])
    })
  })

  describe("getSearchableFields", () => {
    it("returns searchable fields", () => {
      const schema = new Schema({
        version: 1,
        collections: {
          posts: {
            fields: { title: { type: "string" }, content: { type: "string" } },
            searchable: ["title", "content"],
          },
        },
      })
      expect(schema.getSearchableFields("posts")).toEqual(["title", "content"])
    })
  })
})
