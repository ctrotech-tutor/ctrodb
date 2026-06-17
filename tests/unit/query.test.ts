import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryBuilder } from "../../src/query/builder"
import { QueryExecutor } from "../../src/query/executor"
import { QueryPlanner } from "../../src/query/planner"
import { Schema } from "../../src/schema"

const sampleSchema = new Schema({
  version: 1,
  collections: {
    users: {
      fields: {
        name: { type: "string" },
        email: { type: "string" },
        age: { type: "number" },
        role: { type: "string" },
      },
      indexes: [{ field: "email", unique: true }, { field: "age" }],
    },
  },
})

const sampleData = [
  { id: "1", name: "Alice", email: "alice@test.com", age: 30, role: "admin" },
  { id: "2", name: "Bob", email: "bob@test.com", age: 25, role: "user" },
  { id: "3", name: "Charlie", email: "charlie@test.com", age: 35, role: "user" },
  { id: "4", name: "Diana", email: "diana@test.com", age: 28, role: "admin" },
  { id: "5", name: "Eve", email: "eve@test.com", age: 30, role: "moderator" },
]

function isInRange(value: unknown, range: IDBKeyRange): boolean {
  if (range.lower !== undefined) {
    if (range.lowerOpen && (value as number) <= (range.lower as number)) return false
    if (!range.lowerOpen && (value as number) < (range.lower as number)) return false
  }
  if (range.upper !== undefined) {
    if (range.upperOpen && (value as number) >= (range.upper as number)) return false
    if (!range.upperOpen && (value as number) > (range.upper as number)) return false
  }
  return true
}

function simulateIndexScan(
  _collection: string,
  indexName: string,
  range: IDBKeyRange | undefined,
  postFilters: { type: string; field: string; value: unknown }[],
) {
  let results = [...sampleData]
  if (range && indexName) {
    results = results.filter((r) => isInRange((r as any)[indexName], range))
  }
  for (const f of postFilters) {
    if (f.type === "where") {
      results = results.filter((r) => (r as any)[f.field] === f.value)
    }
  }
  return results
}

describe("QueryPlanner", () => {
  const planner = new QueryPlanner()

  it("plans full_scan for empty conditions", () => {
    const plan = planner.plan([[]], null, [])
    expect(plan.strategy).toBe("full_scan")
    expect(plan.groupType).toBe("single")
  })

  it("plans full_scan for no conditions", () => {
    const plan = planner.plan([], null, [])
    expect(plan.strategy).toBe("full_scan")
  })

  it("plans index_scan for indexed field equality", () => {
    const conditions = [
      { type: "where" as const, field: "email", op: "==" as const, value: "a@b.com" },
    ]
    const plan = planner.plan([conditions], null, sampleSchema.getIndexes("users"))
    expect(plan.strategy).toBe("index_scan")
    expect(plan.indexName).toBe("email")
  })

  it("plans full_scan for non-indexed field", () => {
    const conditions = [
      { type: "where" as const, field: "name", op: "==" as const, value: "Alice" },
    ]
    const plan = planner.plan([conditions], null, sampleSchema.getIndexes("users"))
    expect(plan.strategy).toBe("full_scan")
    expect(plan.postFilterConditions).toEqual(conditions)
  })

  it("creates OR plan for multiple condition groups", () => {
    const group1 = [{ type: "where" as const, field: "age", op: "==" as const, value: 30 }]
    const group2 = [{ type: "where" as const, field: "age", op: "==" as const, value: 25 }]
    const plan = planner.plan([group1, group2], null, sampleSchema.getIndexes("users"))
    expect(plan.groupType).toBe("or")
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups![0].strategy).toBe("index_scan")
    expect(plan.groups![1].strategy).toBe("index_scan")
  })

  it("prefers unique index over non-unique", () => {
    // email is unique, age is not
    const conditions = [
      { type: "where" as const, field: "email", op: "==" as const, value: "a@b.com" },
      { type: "where" as const, field: "age", op: "==" as const, value: 30 },
    ]
    const plan = planner.plan([conditions], null, sampleSchema.getIndexes("users"))
    expect(plan.strategy).toBe("index_scan")
    expect(plan.indexName).toBe("email")
  })

  it("prefers equality over range", () => {
    const conditions = [
      { type: "where" as const, field: "age", op: ">=" as const, value: 20 },
      { type: "where" as const, field: "email", op: "==" as const, value: "a@b.com" },
    ]
    const plan = planner.plan([conditions], null, sampleSchema.getIndexes("users"))
    expect(plan.indexName).toBe("email")
  })

  it("creates key range for range operators", () => {
    const conditions = [{ type: "where" as const, field: "age", op: ">=" as const, value: 30 }]
    const plan = planner.plan([conditions], null, sampleSchema.getIndexes("users"))
    expect(plan.strategy).toBe("index_scan")
    expect(plan.range).toBeDefined()
  })

  it("handles search conditions", () => {
    const conditions = [{ type: "search" as const, field: "name", value: "Alice" }]
    const schema = {
      fields: { name: { type: "string" as const } },
      searchable: ["name"],
    }
    const plan = planner.plan([conditions], schema, [])
    expect(plan.strategy).toBe("full_scan")
    expect(plan.primaryConditions[0].type).toBe("search")
  })
})

describe("QueryExecutor", () => {
  const executor = new QueryExecutor()
  let mockAdapter: any

  beforeEach(() => {
    mockAdapter = {
      name: "memory",
      findAll: vi.fn(async () => [...sampleData]),
      findById: vi.fn(
        async (_col: string, id: string) => sampleData.find((r) => r.id === id) ?? null,
      ),
      scanIndex: vi.fn(async (_col: string, _idx: string, range: any, filters: any[]) => {
        return simulateIndexScan(_col, _idx, range, filters as any[])
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => true),
      getSchemaVersion: vi.fn(),
      setSchemaVersion: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      transaction: vi.fn(),
      getMetadata: vi.fn(),
      setMetadata: vi.fn(),
    }
  })

  it("returns all records for full_scan without conditions", async () => {
    const plan = {
      strategy: "full_scan" as const,
      primaryConditions: [],
      postFilterConditions: [],
      groupType: "single" as const,
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    expect(results).toHaveLength(5)
  })

  it("filters records with post conditions", async () => {
    const plan = {
      strategy: "full_scan" as const,
      primaryConditions: [],
      postFilterConditions: [
        { type: "where" as const, field: "role", op: "==" as const, value: "admin" },
      ],
      groupType: "single" as const,
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    expect(results).toHaveLength(2)
    expect((results[0] as any).name).toBe("Alice")
    expect((results[1] as any).name).toBe("Diana")
  })

  it("supports id_lookup strategy", async () => {
    const plan = {
      strategy: "id_lookup" as const,
      primaryConditions: [{ type: "where" as const, field: "id", op: "==" as const, value: "3" }],
      postFilterConditions: [],
      groupType: "single" as const,
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    expect(results).toHaveLength(1)
    expect((results[0] as any).name).toBe("Charlie")
  })

  it("executes OR queries and deduplicates", async () => {
    const plan = {
      strategy: "full_scan" as const,
      groupType: "or" as const,
      groups: [
        {
          strategy: "full_scan" as const,
          primaryConditions: [],
          postFilterConditions: [
            { type: "where" as const, field: "role", op: "==" as const, value: "admin" },
          ],
          groupType: "single" as const,
        },
        {
          strategy: "full_scan" as const,
          primaryConditions: [],
          postFilterConditions: [
            { type: "where" as const, field: "age", op: "==" as const, value: 30 },
          ],
          groupType: "single" as const,
        },
      ],
      primaryConditions: [],
      postFilterConditions: [],
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    // Admins: Alice(30), Diana(28). Age 30: Alice, Eve(30). Union (no dup): Alice, Diana, Eve
    expect(results).toHaveLength(3)
  })

  it("applies sort", async () => {
    const plan = {
      strategy: "full_scan" as const,
      primaryConditions: [],
      postFilterConditions: [],
      groupType: "single" as const,
      sort: { field: "age", direction: "desc" as const },
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    expect(results).toHaveLength(5)
    expect((results[0] as any).age).toBe(35) // Charlie
    expect((results[4] as any).age).toBe(25) // Bob
  })

  it("applies limit and offset", async () => {
    const plan = {
      strategy: "full_scan" as const,
      primaryConditions: [],
      postFilterConditions: [],
      groupType: "single" as const,
      limit: 2,
      offset: 1,
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    expect(results).toHaveLength(2)
    expect((results[0] as any).name).toBe("Bob")
    expect((results[1] as any).name).toBe("Charlie")
  })

  it("supports != operator", async () => {
    const plan = {
      strategy: "full_scan" as const,
      primaryConditions: [],
      postFilterConditions: [
        { type: "where" as const, field: "role", op: "!=" as const, value: "user" },
      ],
      groupType: "single" as const,
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    expect(results).toHaveLength(3) // Alice (admin), Diana (admin), Eve (moderator)
  })

  it("supports < and > operators", async () => {
    const plan = {
      strategy: "full_scan" as const,
      primaryConditions: [],
      postFilterConditions: [
        { type: "where" as const, field: "age", op: ">" as const, value: 28 },
        { type: "where" as const, field: "age", op: "<" as const, value: 35 },
      ],
      groupType: "single" as const,
    }
    const results = await executor.execute(mockAdapter, "users", plan)
    expect(results).toHaveLength(2) // Alice(30), Eve(30)
  })
})

describe("QueryBuilder", () => {
  const planner = new QueryPlanner()
  const executor = new QueryExecutor()
  const mockAdapter = {
    name: "memory",
    findAll: vi.fn(async () => [...sampleData]),
    findById: vi.fn(
      async (_col: string, id: string) => sampleData.find((r) => r.id === id) ?? null,
    ),
    scanIndex: vi.fn(async (_col: string, _idx: string, range: any, filters: any[]) => {
      return simulateIndexScan(_col, _idx, range, filters as any[])
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    getSchemaVersion: vi.fn(),
    setSchemaVersion: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    transaction: vi.fn(),
    getMetadata: vi.fn(),
    setMetadata: vi.fn(),
  }

  const makeModel = (data: any) => ({
    ...data,
    toJSON: () => ({ ...data }),
    update: vi.fn(),
    delete: vi.fn(),
  })

  const mockCollection = {
    name: "users",
    _getSchema: () => sampleSchema,
    _getAdapter: () => mockAdapter,
    _toModels: (raw: any[]) => raw.map(makeModel),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("builds and executes a simple where query", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder.where("role", "==", "admin").fetch()
    expect(results).toHaveLength(2)
  })

  it("supports shorthand where (defaults to ==)", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder.where("role", "admin").fetch()
    expect(results).toHaveLength(2)
  })

  it("supports chaining multiple conditions", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder.where("role", "admin").where("age", 30).fetch()
    expect(results).toHaveLength(1)
    expect((results[0] as any).name).toBe("Alice")
  })

  it("supports orWhere", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder
      .where("age", 25)
      .orWhere((q) => q.where("age", 35))
      .fetch()
    expect(results).toHaveLength(2)
  })

  it("supports first()", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const result = await builder.where("role", "user").first()
    expect(result).toBeDefined()
    expect((result as any).name).toBe("Bob")
  })

  it("supports count()", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const count = await builder.where("role", "admin").count()
    expect(count).toBe(2)
  })

  it("supports toArray() returning plain objects", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder.where("role", "user").toArray()
    expect(results).toHaveLength(2)
    expect(results[0]).not.toHaveProperty("toJSON")
  })

  it("supports sort", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder.sort({ age: "desc" }).toArray()
    expect((results[0] as any).age).toBe(35)
    expect((results[4] as any).age).toBe(25)
  })

  it("supports limit and offset", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder.sort({ age: "asc" }).limit(2).offset(1).toArray()
    expect(results).toHaveLength(2)
    expect((results[0] as any).age).toBe(28) // Diana
    expect((results[1] as any).age).toBe(30) // Alice (first of age 30)
  })

  it("supports search conditions", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const results = await builder.search("name", "Ali").fetch()
    expect(results).toBeDefined()
  })

  it("throws for unsupported operator", () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    expect(() => (builder as any).where("age", "=~", 30)).toThrow("Unsupported operator '=~'")
  })

  it("count returns 0 for no matches", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const count = await builder.where("age", 999).count()
    expect(count).toBe(0)
  })

  it("first returns undefined for no matches", async () => {
    const builder = new QueryBuilder(mockCollection as any, planner, executor)
    const result = await builder.where("age", 999).first()
    expect(result).toBeUndefined()
  })
})
