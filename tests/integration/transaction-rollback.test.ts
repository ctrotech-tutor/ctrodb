import { describe, expect, it } from "vitest"
import { MemoryAdapter } from "../../src/adapter/memory"
import { Database } from "../../src/database"
import { Schema } from "../../src/schema"

const schema = new Schema({
  version: 1,
  collections: {
    accounts: {
      fields: {
        name: { type: "string", required: true },
        balance: { type: "number", default: 0 },
      },
    },
  },
})

describe("transaction rollback", () => {
  it("disconnect clears MemoryAdapter, reconnect starts fresh", async () => {
    const db = new Database({
      name: "tx-disconnect-test",
      adapter: new MemoryAdapter(),
      schema,
    })
    await db.connect()

    const accounts = db.collection("accounts")
    await accounts.create({ name: "Temp", balance: 100 })
    expect(await accounts.count()).toBe(1)

    await db.disconnect()
    await db.connect()

    expect(await db.collection("accounts").count()).toBe(0)

    await db.disconnect()
  })

  it("adapter.transaction rolls back context writes on error", async () => {
    const db = new Database({
      name: "tx-transaction-test",
      adapter: new MemoryAdapter(),
      schema,
    })
    await db.connect()

    const accounts = db.collection("accounts")
    await accounts.create({ name: "Persistent", balance: 500 })
    expect(await accounts.count()).toBe(1)

    // Transactional writes go through the scoped context. (Collection writes
    // are separate operations on both adapters — see README "Transactions".)
    await expect(
      db.transaction(async (ctx) => {
        await ctx.collection("accounts").create({
          id: "rolled-back",
          name: "Rolled Back",
          balance: 100,
        })
        throw new Error("simulated failure")
      }),
    ).rejects.toThrow("simulated failure")

    expect(await accounts.count()).toBe(1)

    await db.disconnect()
  })
})
