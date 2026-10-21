import { describe, expect, it, vi } from "vitest"
import { Model } from "../../src/model/index"
import { Schema } from "../../src/schema"

const mockCollection = (overrides = {}) => ({
  name: "users",
  update: vi.fn(async (_id: any, changes: any) => {
    const data: any = { id: "1", name: "Alice", age: 30, ...changes }
    return new Model(data, mockCollection(), mockDatabase(), null)
  }),
  delete: vi.fn(async (_id: any) => {}),
  _getSchema: vi.fn(() => null),
  ...overrides,
})

const mockDatabase = () => ({
  collection: vi.fn(() => ({
    query: vi.fn(() => ({
      where: vi.fn(() => ({
        toArray: vi.fn(() => Promise.resolve([])),
      })),
    })),
  })),
})

describe("Model", () => {
  it("stores data and exposes id", () => {
    const data = { id: "1" as any, name: "Alice" }
    const model = new Model(data, mockCollection(), mockDatabase(), null)
    expect(model.id).toBe("1")
  })

  it("provides proxy access to data fields", () => {
    const data = { id: "1" as any, name: "Alice", age: 30 }
    const model = new Model(data, mockCollection(), mockDatabase(), null)
    expect((model as any).name).toBe("Alice")
    expect((model as any).age).toBe(30)
  })

  it("toJSON returns a copy of the data", () => {
    const data = { id: "1" as any, name: "Alice" }
    const model = new Model(data, mockCollection(), mockDatabase(), null)
    const json = model.toJSON()
    expect(json).toEqual(data)
    expect(json).not.toBe(data)
  })

  it("update() calls collection.update and returns a new model", async () => {
    const col = mockCollection()
    const data = { id: "1" as any, name: "Alice" }
    const model = new Model(data, col, mockDatabase(), null)
    const result = await model.update({ name: "Bob" })
    expect(col.update).toHaveBeenCalledWith("1", { name: "Bob" })
    expect((result as any).name).toBe("Bob")
  })

  it("delete() calls collection.delete", async () => {
    const col = mockCollection()
    const data = { id: "1" as any, name: "Alice" }
    const model = new Model(data, col, mockDatabase(), null)
    await model.delete()
    expect(col.delete).toHaveBeenCalledWith("1")
  })

  it("throws on direct assignment instead of silently dropping the write", () => {
    const data = { id: "1" as any, name: "Alice" }
    const model = new Model(data, mockCollection(), mockDatabase(), null)

    // Previously this logged a warning and returned `true`, so the assignment
    // looked successful while the value never changed (audit M-12).
    expect(() => {
      ;(model as any).name = "Bob"
    }).toThrow(/Cannot assign "name" directly/)

    expect((model as any).name).toBe("Alice")
  })

  it("exposes the record's fields to ordinary JavaScript (M-12)", () => {
    const data = { id: "1" as any, name: "Alice", age: 30 }
    const model = new Model(data, mockCollection(), mockDatabase(), null)

    expect(Object.keys(model).sort()).toEqual(["age", "id", "name"])
    expect({ ...model }).toMatchObject({ id: "1", name: "Alice", age: 30 })
    expect(JSON.parse(JSON.stringify(model))).toEqual({ id: "1", name: "Alice", age: 30 })
    expect("name" in model).toBe(true)
    expect(Object.hasOwn(model, "name")).toBe(true)
    expect(JSON.parse(JSON.stringify({ model }))).toEqual({
      model: { id: "1", name: "Alice", age: 30 },
    })
  })

  it("keeps the synthetic field keys read-only (M-12)", () => {
    const model = new Model(
      { id: "1" as any, name: "Alice" },
      mockCollection(),
      mockDatabase(),
      null,
    )

    expect(model.constructor).toBe(Model)
    expect(() => Object.defineProperty(model, "name", { value: "Mallory" })).toThrow(
      /Cannot redefine "name"/,
    )
    expect(() => Reflect.deleteProperty(model, "name")).toThrow(/Cannot delete "name"/)
    expect((model as any).name).toBe("Alice")
  })

  it("does not mistake the wrapper for a thenable", async () => {
    const model = new Model(
      { id: "1" as any, name: "Alice" },
      mockCollection(),
      mockDatabase(),
      null,
    )
    await expect(Promise.resolve(model)).resolves.toBe(model)
  })

  describe("relation getters", () => {
    it("defines relation getters from schema", () => {
      const schema = new Schema({
        version: 1,
        collections: {
          users: {
            fields: { name: { type: "string" } },
            relations: {
              posts: {
                type: "has_many",
                collection: "posts",
                foreignKey: "userId",
              },
            },
          },
          posts: {
            fields: { title: { type: "string" } },
          },
        },
      })
      const data = { id: "1" as any, name: "Alice" }
      const model = new Model(data, mockCollection(), mockDatabase(), schema)
      expect(typeof (model as any).posts).toBe("object")
    })
  })
})
