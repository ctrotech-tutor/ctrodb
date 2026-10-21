/**
 * Adapter contract parity (audit H-03/H-04/H-05/H-08).
 *
 * Every assertion here runs against **both** adapters, because the original
 * defects were divergences: code that passed on memory failed or behaved
 * differently on IndexedDB, and vice versa.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Database } from "../../src/database"
import type { ID, TransactionContext } from "../../src/types"

const schema = {
  version: 1,
  collections: {
    accounts: {
      fields: { owner: { type: "string" }, balance: { type: "number" } },
      indexes: [{ field: "owner" }],
    },
  },
} as const

const open: Database[] = []

async function makeDb(adapter: "memory" | "indexeddb"): Promise<Database> {
  const db = new Database({
    name: `parity-${adapter}-${Math.random().toString(36).slice(2)}`,
    adapter,
    schema: schema as never,
  })
  await db.connect()
  open.push(db)
  return db
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.disconnect().catch(() => {})
})

describe.each(["memory", "indexeddb"] as const)("transaction semantics (%s)", (adapter) => {
  it("commits every write made through the context", async () => {
    const db = await makeDb(adapter)

    await db.transaction(async (ctx: TransactionContext) => {
      const accounts = ctx.collection("accounts")
      await accounts.create({ id: "a1", owner: "ada", balance: 10 })
      await accounts.create({ id: "a2", owner: "grace", balance: 20 })
    })

    expect(await db.collection("accounts").count()).toBe(2)
  })

  it("rolls back every context write and preserves the original error", async () => {
    const db = await makeDb(adapter)

    await expect(
      db.transaction(async (ctx: TransactionContext) => {
        const accounts = ctx.collection("accounts")
        await accounts.create({ id: "a1", owner: "ada", balance: 10 })
        await accounts.create({ id: "a2", owner: "grace", balance: 20 })
        throw new Error("insufficient funds")
      }),
    ).rejects.toThrow("insufficient funds")

    // No partial rows, on either adapter.
    expect(await db.collection("accounts").count()).toBe(0)
  })

  it("reverts an update and a delete when the transaction fails", async () => {
    const db = await makeDb(adapter)
    const accounts = db.collection("accounts")
    await accounts.create({ id: "a1", owner: "ada", balance: 10 })
    await accounts.create({ id: "a2", owner: "grace", balance: 20 })

    await expect(
      db.transaction(async (ctx: TransactionContext) => {
        const scoped = ctx.collection("accounts")
        await scoped.update("a1", { balance: 999 })
        await scoped.delete("a2")
        throw new Error("nope")
      }),
    ).rejects.toThrow("nope")

    expect((await accounts.get("a1"))?.balance).toBe(10)
    expect(await accounts.get("a2")).toBeDefined()
  })

  it("does not roll back writes made outside the transaction (H-05)", async () => {
    const db = await makeDb(adapter)
    const accounts = db.collection("accounts")
    await accounts.create({ id: "pre", owner: "pre", balance: 1 })

    let outside: Promise<unknown> | undefined
    await expect(
      db.transaction(async (ctx: TransactionContext) => {
        await ctx.collection("accounts").create({ id: "inside", owner: "in", balance: 2 })
        // Interleave an unrelated write while the transaction is in flight.
        // It is deliberately not awaited: awaiting non-database work inside an
        // IndexedDB transaction lets the transaction auto-commit.
        outside = accounts.create({ id: "outside", owner: "out", balance: 3 })
        throw new Error("abort")
      }),
    ).rejects.toThrow("abort")
    await outside

    // The transactional write is gone; the unrelated one survives.
    expect(await accounts.get("inside")).toBeUndefined()
    expect(await accounts.get("outside")).toBeDefined()
    expect(await accounts.get("pre")).toBeDefined()
  })

  it("leaves no partial state when the context writes to a missing record", async () => {
    const db = await makeDb(adapter)

    await expect(
      db.transaction(async (ctx: TransactionContext) => {
        const scoped = ctx.collection("accounts")
        await scoped.create({ id: "a1", owner: "ada", balance: 1 })
        await scoped.update("missing", { balance: 5 })
      }),
    ).rejects.toThrow(/not found/)

    expect(await db.collection("accounts").count()).toBe(0)
  })
})

describe.each(["memory", "indexeddb"] as const)("query ordering parity (%s)", (adapter) => {
  const insert = async (db: Database, ids: ID[]) => {
    const accounts = db.collection("accounts")
    for (const id of ids) {
      await accounts.create({ id, owner: "same", balance: 1 })
    }
  }

  it("returns results in primary-key ascending order by default (H-08)", async () => {
    const db = await makeDb(adapter)
    await insert(db, ["zzz", "aaa", "mmm"])

    const rows = await db.collection("accounts").query().fetch()
    expect(rows.map((r) => r.id)).toEqual(["aaa", "mmm", "zzz"])
  })

  it("applies limit() to the same deterministic window on both adapters", async () => {
    const db = await makeDb(adapter)
    await insert(db, ["zzz", "aaa", "mmm"])

    const page = await db
      .collection("accounts")
      .query()
      .where("owner", "==", "same")
      .limit(2)
      .fetch()
    expect(page.map((r) => r.id)).toEqual(["aaa", "mmm"])
  })

  it("applies offset() without an explicit sort", async () => {
    const db = await makeDb(adapter)
    await insert(db, ["zzz", "aaa", "mmm"])

    const page = await db.collection("accounts").query().offset(1).limit(1).fetch()
    expect(page.map((r) => r.id)).toEqual(["mmm"])
  })

  it("orders and windows an OR query (previously ignored entirely)", async () => {
    const db = await makeDb(adapter)
    await insert(db, ["zzz", "aaa", "mmm"])

    const rows = await db
      .collection("accounts")
      .query()
      .where("id", "==", "zzz")
      .orWhere((q) => q.where("id", "==", "aaa"))
      .limit(2)
      .fetch()

    expect(rows.map((r) => r.id)).toEqual(["aaa", "zzz"])
  })

  it("honours an explicit sort direction over the default order", async () => {
    const db = await makeDb(adapter)
    await insert(db, ["aaa", "mmm", "zzz"])

    const rows = await db.collection("accounts").query().sort({ id: "desc" }).fetch()
    expect(rows.map((r) => r.id)).toEqual(["zzz", "mmm", "aaa"])
  })
})
