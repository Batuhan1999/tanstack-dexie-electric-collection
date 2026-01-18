import "./fake-db"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCollection } from "@tanstack/db"
import { dexieCollectionOptions } from "../src/dexie"
import {
  cleanupTestResources,
  createTestState,
  waitForKey,
} from "./test-helpers"

describe(`Dexie persistence handlers`, () => {
  afterEach(cleanupTestResources)

  it(`onInsert is called by write path with item data`, async () => {
    const { db } = await createTestState()

    let capturedItem: any = null
    const opts = dexieCollectionOptions({
      id: `insert-handler`,
      tableName: `test`,
      dbName: db.name,
      getKey: (i: any) => i.id,
      onInsert: async (item) => {
        capturedItem = item
      },
    })

    const col = createCollection(opts)
    await col.stateWhenReady()

    col.insert({ id: `p1`, name: `TestItem` })

    // Wait for write path to call handler
    await new Promise((r) => setTimeout(r, 200))

    expect(capturedItem).not.toBeNull()
    expect(capturedItem.id).toBe(`p1`)
    expect(capturedItem.name).toBe(`TestItem`)
  })

  it(`onUpdate is called with id, changes, and modifiedColumns`, async () => {
    const { db } = await createTestState([{ id: `u1`, name: `Original` }])

    let capturedId: any = null
    let capturedChanges: any = null
    let capturedColumns: any = null

    const opts = dexieCollectionOptions({
      id: `update-handler`,
      tableName: `test`,
      dbName: db.name,
      getKey: (i: any) => i.id,
      onUpdate: async (id, changes, modifiedColumns) => {
        capturedId = id
        capturedChanges = changes
        capturedColumns = modifiedColumns
      },
    })

    const col = createCollection(opts)
    await col.stateWhenReady()
    await waitForKey(col, `u1`, 500)

    col.update(`u1`, (d: any) => {
      d.name = `Updated`
    })

    // Wait for write path to call handler
    await new Promise((r) => setTimeout(r, 200))

    expect(capturedId).toBe(`u1`)
    expect(capturedChanges).toBeDefined()
    expect(capturedColumns).toContain(`name`)
  })

  it(`onDelete is called with id`, async () => {
    const { db } = await createTestState([{ id: `d1`, name: `ToDelete` }])

    let capturedId: any = null

    const opts = dexieCollectionOptions({
      id: `delete-handler`,
      tableName: `test`,
      dbName: db.name,
      getKey: (i: any) => i.id,
      onDelete: async (id) => {
        capturedId = id
      },
    })

    const col = createCollection(opts)
    await col.stateWhenReady()
    await waitForKey(col, `d1`, 500)

    col.delete(`d1`)

    // Wait for write path to call handler
    await new Promise((r) => setTimeout(r, 200))

    expect(capturedId).toBe(`d1`)
  })

  it(`handler errors trigger retry with exponential backoff`, async () => {
    const { db } = await createTestState()

    let callCount = 0

    const opts = dexieCollectionOptions({
      id: `retry-test`,
      tableName: `test`,
      dbName: db.name,
      getKey: (i: any) => i.id,
      syncRetryMaxAttempts: 3,
      syncRetryBaseDelayMs: 50,
      onInsert: async () => {
        callCount++
        if (callCount < 3) {
          throw new Error(`simulated-failure`)
        }
        // Success on 3rd attempt
      },
    })

    const col = createCollection(opts)
    await col.stateWhenReady()

    col.insert({ id: `retry1`, name: `Retry` })

    // Wait for retries: 50ms + 100ms + buffer
    await new Promise((r) => setTimeout(r, 500))

    // Should have retried until success
    expect(callCount).toBe(3)
  })

  it(`max retries exceeded reverts create operation`, async () => {
    const { db } = await createTestState()

    const opts = dexieCollectionOptions({
      id: `revert-create`,
      tableName: `test`,
      dbName: db.name,
      getKey: (i: any) => i.id,
      syncRetryMaxAttempts: 2,
      syncRetryBaseDelayMs: 50,
      onInsert: async () => {
        throw new Error(`always-fail`)
      },
    })

    const col = createCollection(opts)
    await col.stateWhenReady()

    col.insert({ id: `revert1`, name: `WillRevert` })

    // Wait for retries and revert: 50ms + 100ms + buffer
    await new Promise((r) => setTimeout(r, 400))

    // Item should be deleted after max retries (reverted)
    const dbItem = await db.table(`test`).get(`revert1`)
    expect(dbItem).toBeUndefined()
  })

  it(`no handler configured: write path marks as synced without calling handler`, async () => {
    const { db } = await createTestState()

    // No onInsert handler
    const opts = dexieCollectionOptions({
      id: `no-handler`,
      tableName: `test`,
      dbName: db.name,
      getKey: (i: any) => i.id,
    })

    const col = createCollection(opts)
    await col.stateWhenReady()

    col.insert({ id: `nh1`, name: `NoHandler` })

    // Wait for write path
    await new Promise((r) => setTimeout(r, 200))

    // Item should exist in DB
    const dbItem = await db.table(`test`).get(`nh1`)
    expect(dbItem).toBeDefined()
    expect(dbItem.name).toBe(`NoHandler`)
  })

  it(`multiple rapid inserts are all synced`, async () => {
    const { db } = await createTestState()

    const insertedItems: string[] = []

    const opts = dexieCollectionOptions({
      id: `rapid-inserts`,
      tableName: `test`,
      dbName: db.name,
      getKey: (i: any) => i.id,
      onInsert: async (item: any) => {
        insertedItems.push(item.id)
      },
    })

    const col = createCollection(opts)
    await col.stateWhenReady()

    // Rapid inserts
    for (let i = 0; i < 5; i++) {
      col.insert({ id: `rapid-${i}`, name: `R${i}` })
    }

    // Wait for write path to process all
    await new Promise((r) => setTimeout(r, 500))

    expect(insertedItems.length).toBe(5)
    expect(insertedItems).toContain(`rapid-0`)
    expect(insertedItems).toContain(`rapid-4`)
  })
})
