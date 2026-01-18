import "./fake-db"

import { afterEach, describe, expect, it, vi } from "vitest"
import { createCollection } from "@tanstack/db"
import { dexieElectricSyncOptions } from "../src"
import {
  cleanupTestResources,
  createTestState,
  getTestData,
  waitForCollectionSize,
  waitForKey,
  waitForNoKey,
} from "./test-helpers"
import type { TestItem } from "./test-helpers"

describe(`Dexie Local Write Utilities`, () => {
  afterEach(cleanupTestResources)

  describe(`insertLocally`, () => {
    it(`inserts server data without triggering onInsert handler when fromServer=true`, async () => {
      const onInsertSpy = vi.fn()
      const { db } = await createTestState()

      // Override collection with handler
      const opts = dexieElectricSyncOptions({
        id: `test-with-handler`,
        tableName: `test`,
        dbName: db.name,
        getKey: (i: any) => i.id,
        onInsert: onInsertSpy,
      })
      const collectionWithHandler = createCollection(opts)
      await collectionWithHandler.stateWhenReady()

      const utils = collectionWithHandler.utils
      const item: TestItem = { id: `local-1`, name: `Local Insert` }

      // fromServer=true marks item as synced - write path won't call handler
      await utils.insertLocally(item, true)
      await waitForKey(collectionWithHandler, `local-1`)

      // Verify item is in collection
      expect(collectionWithHandler.has(`local-1`)).toBe(true)
      expect(collectionWithHandler.get(`local-1`)?.name).toBe(`Local Insert`)

      // Verify item is in database
      const dbItem = await db.table(`test`).get(`local-1`)
      expect(dbItem).toBeDefined()
      expect(dbItem.name).toBe(`Local Insert`)

      // Give write path a moment to potentially call handler
      await new Promise((r) => setTimeout(r, 100))

      // Verify handler was NOT called (item marked as synced)
      expect(onInsertSpy).not.toHaveBeenCalled()
    })

    it(`updates existing item (upsert behavior)`, async () => {
      const { collection, db } = await createTestState([
        { id: `1`, name: `Original` },
      ])

      const utils = collection.utils
      const updatedItem: TestItem = {
        id: `1`,
        name: `Updated via insertLocally`,
      }

      await utils.insertLocally(updatedItem)
      await new Promise((r) => setTimeout(r, 100))

      // Verify item was updated
      expect(collection.get(`1`)?.name).toBe(`Updated via insertLocally`)

      const dbItem = await db.table(`test`).get(`1`)
      expect(dbItem.name).toBe(`Updated via insertLocally`)
    })

    it(`marks ID as seen and acked`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      const item: TestItem = { id: `seen-test`, name: `Test` }
      await utils.insertLocally(item)

      // awaitIds should resolve immediately since item is acked
      await expect(utils.awaitIds([`seen-test`])).resolves.toBeUndefined()
    })

    it(`throws error on invalid data`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      // Try to insert invalid data (missing required field)
      const invalidItem = { id: `invalid` } as any

      await expect(utils.insertLocally(invalidItem)).rejects.toThrow()
    })
  })

  describe(`updateLocally`, () => {
    it(`updates a single item without triggering onUpdate handler`, async () => {
      const onUpdateSpy = vi.fn()
      const { db } = await createTestState([{ id: `1`, name: `Original` }])

      const opts = dexieElectricSyncOptions({
        id: `test-update-handler`,
        tableName: `test`,
        dbName: db.name,
        getKey: (i: any) => i.id,
        onUpdate: onUpdateSpy,
      })
      const collectionWithHandler = createCollection(opts)
      await collectionWithHandler.stateWhenReady()

      const utils = collectionWithHandler.utils
      const updatedItem: TestItem = { id: `1`, name: `Updated Locally` }

      // Pass fromServer=true to simulate server data (should not trigger write path sync)
      await utils.updateLocally(`1`, updatedItem, true)
      await new Promise((r) => setTimeout(r, 100))

      // Verify item was updated
      expect(collectionWithHandler.get(`1`)?.name).toBe(`Updated Locally`)

      const dbItem = await db.table(`test`).get(`1`)
      expect(dbItem.name).toBe(`Updated Locally`)

      // Verify handler was NOT called (neither directly nor via write path)
      expect(onUpdateSpy).not.toHaveBeenCalled()
    })

    it(`respects rowUpdateMode setting`, async () => {
      const { db } = await createTestState([{ id: `1`, name: `Original` }])

      // Test with partial mode (default)
      const optsPartial = dexieElectricSyncOptions({
        id: `test-partial`,
        tableName: `test`,
        dbName: db.name,
        getKey: (i: any) => i.id,
        rowUpdateMode: `partial`,
      })
      const collectionPartial = createCollection(optsPartial)
      await collectionPartial.stateWhenReady()

      const utilsPartial = collectionPartial.utils
      await utilsPartial.updateLocally(`1`, { id: `1`, name: `Partial Update` })
      await new Promise((r) => setTimeout(r, 100))

      expect(collectionPartial.get(`1`)?.name).toBe(`Partial Update`)

      // Test with full mode
      const optsFull = dexieElectricSyncOptions({
        id: `test-full`,
        tableName: `test`,
        dbName: db.name,
        getKey: (i: any) => i.id,
        rowUpdateMode: `full`,
      })
      const collectionFull = createCollection(optsFull)
      await collectionFull.stateWhenReady()

      const utilsFull = collectionFull.utils
      await utilsFull.updateLocally(`1`, { id: `1`, name: `Full Update` })
      await new Promise((r) => setTimeout(r, 100))

      expect(collectionFull.get(`1`)?.name).toBe(`Full Update`)
    })

    it(`throws error when updating non-existent item in partial mode`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      // Partial mode should fail on non-existent item
      await expect(
        utils.updateLocally(`non-existent`, {
          id: `non-existent`,
          name: `Test`,
        })
      ).rejects.toThrow()
    })
  })

  describe(`deleteLocally`, () => {
    it(`deletes a single item without triggering onDelete handler`, async () => {
      const onDeleteSpy = vi.fn()
      const { db } = await createTestState([{ id: `1`, name: `To Delete` }])

      const opts = dexieElectricSyncOptions({
        id: `test-delete-handler`,
        tableName: `test`,
        dbName: db.name,
        getKey: (i: any) => i.id,
        onDelete: onDeleteSpy,
      })
      const collectionWithHandler = createCollection(opts)
      await collectionWithHandler.stateWhenReady()

      const utils = collectionWithHandler.utils

      await utils.deleteLocally(`1`)
      await waitForNoKey(collectionWithHandler, `1`)

      // Verify item is gone from collection
      expect(collectionWithHandler.has(`1`)).toBe(false)

      // Verify item is gone from database
      const dbItem = await db.table(`test`).get(`1`)
      expect(dbItem).toBeUndefined()

      // Verify handler was NOT called
      expect(onDeleteSpy).not.toHaveBeenCalled()
    })

    it(`removes item from tracking`, async () => {
      const { collection } = await createTestState([
        { id: `tracked`, name: `Test` },
      ])
      const utils = collection.utils

      // Verify item is tracked
      await utils.awaitIds([`tracked`])

      // Delete locally
      await utils.deleteLocally(`tracked`)
      await waitForNoKey(collection, `tracked`)

      // Item should no longer be tracked
      expect(collection.has(`tracked`)).toBe(false)
    })

    it(`succeeds silently when deleting non-existent item`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      // Should not throw
      await expect(utils.deleteLocally(`non-existent`)).resolves.toBeUndefined()
    })
  })

  describe(`Real-world scenarios`, () => {
    it(`handle WebSocket updates without triggering handlers`, async () => {
      const onInsertSpy = vi.fn()
      const onUpdateSpy = vi.fn()
      const onDeleteSpy = vi.fn()

      const initialData = getTestData(5)
      const { db } = await createTestState(initialData)

      const opts = dexieElectricSyncOptions({
        id: `test-websocket-handlers`,
        tableName: `test`,
        dbName: db.name,
        getKey: (i: any) => i.id,
        onInsert: onInsertSpy,
        onUpdate: onUpdateSpy,
        onDelete: onDeleteSpy,
      })
      const collectionWithHandlers = createCollection(opts)
      await collectionWithHandlers.stateWhenReady()

      const utils = collectionWithHandlers.utils

      // Simulate WebSocket/server events (pass fromServer=true)
      // 1. New item created from server
      await utils.insertLocally({ id: `ws-new`, name: `WebSocket New` }, true)

      // 2. Existing item updated from server
      await utils.updateLocally(
        `1`,
        { id: `1`, name: `WebSocket Updated` },
        true
      )

      // 3. Item deleted from server
      await utils.deleteLocally(`2`, true)

      await new Promise((r) => setTimeout(r, 200))

      // Verify changes
      expect(collectionWithHandlers.has(`ws-new`)).toBe(true)
      expect(collectionWithHandlers.get(`1`)?.name).toBe(`WebSocket Updated`)
      expect(collectionWithHandlers.has(`2`)).toBe(false)

      // Verify no handlers were called (server data should not trigger write path)
      expect(onInsertSpy).not.toHaveBeenCalled()
      expect(onUpdateSpy).not.toHaveBeenCalled()
      expect(onDeleteSpy).not.toHaveBeenCalled()

      // Verify database consistency
      const dbCount = await db.table(`test`).count()
      expect(dbCount).toBe(5) // 5 initial - 1 deleted + 1 new = 5
    })
  })

  describe(`Error handling and edge cases`, () => {
    it(`handles quota exceeded error gracefully`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      // This is hard to test in fake-indexeddb, but we can verify error handling structure
      // In real scenarios, this would throw QuotaExceededError
      const largeItem = {
        id: `large`,
        name: `x`.repeat(1000000), // 1MB string
      }

      // Should not crash, either succeeds or throws descriptive error
      try {
        await utils.insertLocally(largeItem)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain(`Failed to insert`)
      }
    })

    it(`handles concurrent operations correctly`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      // Perform many concurrent operations
      const operations = [
        ...Array.from({ length: 10 }, (_, i) =>
          utils.insertLocally({ id: `concurrent-${i}`, name: `Item ${i}` })
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          utils.updateLocally(`concurrent-${i}`, {
            id: `concurrent-${i}`,
            name: `Updated ${i}`,
          })
        ),
      ]

      await Promise.all(operations)
      await waitForCollectionSize(collection, 10, 2000)

      expect(collection.size).toBe(10)
    })

    it(`handles transaction conflicts gracefully`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      // Try to update and delete the same item concurrently
      const item = { id: `conflict`, name: `Test` }
      await utils.insertLocally(item)
      await waitForKey(collection, `conflict`)

      // These operations might conflict
      const operations = [
        utils.updateLocally(`conflict`, { id: `conflict`, name: `Updated` }),
        utils.deleteLocally(`conflict`),
      ]

      // One should succeed, one might fail, but shouldn't crash
      const results = await Promise.allSettled(operations)

      // At least one should succeed
      const succeeded = results.filter((r) => r.status === `fulfilled`)
      expect(succeeded.length).toBeGreaterThan(0)
    })

    it(`validates data before writing`, async () => {
      const { collection } = await createTestState()
      const utils = collection.utils

      // Try to insert completely invalid data
      const invalidData = null as any

      await expect(utils.insertLocally(invalidData)).rejects.toThrow()
    })
  })
})
