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

  it("proxy setter warns about direct assignment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const data = { id: "1" as any, name: "Alice" }
    const model = new Model(data, mockCollection(), mockDatabase(), null)
    ;(model as any).name = "Bob"
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Direct property assignment is not allowed"),
    )
    warn.mockRestore()
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
