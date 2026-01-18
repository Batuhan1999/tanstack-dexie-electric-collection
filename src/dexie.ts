import Dexie, { liveQuery } from "dexie"
import DebugModule from "debug"
import {
  ActionTypes,
  addDexieMetadata,
  needsSync,
  stripDexieFields,
} from "./helper"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type {
  CollectionConfig,
  DeleteMutationFnParams,
  InferSchemaOutput,
  InsertMutationFnParams,
  Row,
  SyncConfig,
  UpdateMutationFnParams,
  UtilsRecord,
} from "@tanstack/db"
import type { Subscription, Table } from "dexie"
import {
  isChangeMessage,
  isControlMessage,
  ShapeStream,
} from "@electric-sql/client"
import z from "zod"

const debug = DebugModule.debug(`ts/db:dexie`)

// ============================================================================
// Shape State Persistence - for resuming Electric sync across page loads
// ============================================================================

interface PersistedShapeState {
  handle: string
  offset: string
  timestamp: number
}

const SHAPE_STATE_KEY = `electric_shape_state`
const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

function loadAllShapeStates(): Record<string, PersistedShapeState> {
  try {
    if (typeof localStorage === `undefined`) return {}
    const stored = localStorage.getItem(SHAPE_STATE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    debug(`[Electric] Failed to load shape states:`, e)
  }
  return {}
}

function loadShapeState(shapeName: string): PersistedShapeState | null {
  const states = loadAllShapeStates()
  const state = states[shapeName]
  if (state) {
    // Check if state is still fresh
    if (Date.now() - state.timestamp < STATE_MAX_AGE_MS) {
      return state
    }
    // State is stale, remove it
    delete states[shapeName]
    try {
      localStorage.setItem(SHAPE_STATE_KEY, JSON.stringify(states))
    } catch (e) {
      debug(`[Electric] Failed to clear stale state:`, e)
    }
  }
  return null
}

function saveShapeState(
  shapeName: string,
  handle: string,
  offset: string
): void {
  try {
    if (typeof localStorage === `undefined`) return
    const states = loadAllShapeStates()
    states[shapeName] = { handle, offset, timestamp: Date.now() }
    localStorage.setItem(SHAPE_STATE_KEY, JSON.stringify(states))
  } catch (e) {
    debug(`[Electric:${shapeName}] Failed to save state:`, e)
  }
}

function clearShapeState(shapeName: string): void {
  try {
    if (typeof localStorage === `undefined`) return
    const states = loadAllShapeStates()
    delete states[shapeName]
    localStorage.setItem(SHAPE_STATE_KEY, JSON.stringify(states))
  } catch (e) {
    debug(`[Electric:${shapeName}] Failed to clear state:`, e)
  }
}

// Optional codec interface for data transformation
export interface DexieCodec<TItem, TStored = TItem> {
  parse?: (raw: TStored) => TItem
  serialize?: (item: TItem) => TStored
}

export const deleteSchema = z.object({
  _deleted: z.boolean(),
})

/**
 * Configuration interface for Dexie collection options
 * @template TItem - The explicit type of items in the collection (highest priority)
 * @template TSchema - The schema type for validation and type inference (second priority)
 *
 * @remarks
 * Type resolution follows a priority order:
 * 1. If you provide an explicit type via generic parameter, it will be used
 * 2. If no explicit type is provided but a schema is, the schema's output type will be inferred
 *
 * You should provide EITHER an explicit type OR a schema, but not both, as they would conflict.
 * Notice that primary keys in Dexie can be string or number.
 */
export interface DexieCollectionConfig<
  TItem extends object = Record<string, unknown>,
  TSchema extends StandardSchemaV1 = never,
> extends Omit<
  CollectionConfig<TItem, string | number, TSchema>,
  `onInsert` | `onUpdate` | `onDelete` | `getKey` | `sync`
> {
  dbName?: string
  tableName?: string
  storeName?: string
  codec?: DexieCodec<TItem>
  schema?: TSchema
  rowUpdateMode?: `partial` | `full`
  syncBatchSize?: number
  ackTimeoutMs?: number
  awaitTimeoutMs?: number
  getKey: (item: TItem) => string | number
  shapeUrl?: string

  // Write path handlers - called by write path watcher when syncing to server
  // These are simpler signatures than TanStack mutation params
  onInsert?: (item: TItem) => Promise<void> | void
  onUpdate?: (
    id: string | number,
    changes: Partial<TItem>,
    modifiedColumns: string[]
  ) => Promise<void> | void
  onDelete?: (id: string | number) => Promise<void> | void

  // Write path configuration
  // Maximum retry attempts before silent revert. Default: 5.
  syncRetryMaxAttempts?: number
  // Base delay (ms) for exponential backoff. Default: 1000.
  syncRetryBaseDelayMs?: number
}

// Enhanced utils interface
export interface DexieUtils extends UtilsRecord {
  getTable: () => Table<Record<string, unknown>, string | number>

  awaitIds: (ids: Array<string | number>) => Promise<void>

  refresh: () => void

  refetch: () => Promise<void>

  // Local-only write utilities (do NOT trigger user handlers)
  insertLocally: (item: any) => Promise<void>
  updateLocally: (id: string | number, item: any) => Promise<void>
  deleteLocally: (id: string | number) => Promise<void>
}

/**
 * Creates Dexie collection options for use with a standard Collection
 *
 * @template TItem - The explicit type of items in the collection (highest priority)
 * @template TSchema - The schema type for validation and type inference (second priority)
 * @param config - Configuration options for the Dexie collection
 * @returns Collection options with utilities
 */
export function dexieElectricSyncOptions<T extends StandardSchemaV1>(
  config: DexieCollectionConfig<InferSchemaOutput<T>, T>
): CollectionConfig<InferSchemaOutput<T>, string | number, T> & {
  schema: T
  utils: DexieUtils
}

export function dexieElectricSyncOptions<T extends object>(
  config: DexieCollectionConfig<T> & { schema?: never }
): CollectionConfig<T, string | number> & {
  schema?: never
  utils: DexieUtils
}

export function dexieElectricSyncOptions<
  TItem extends object = Record<string, unknown>,
  TSchema extends StandardSchemaV1 = never,
>(
  config: DexieCollectionConfig<TItem, TSchema>
): CollectionConfig<TItem, string | number, TSchema> & { utils: DexieUtils } {
  // Track IDs seen by the reactive layer (timestamp as value) - per collection instance
  const seenIds = new Map<string | number, number>()

  // Ack helpers: `ackedIds` = acknowledged IDs, `pendingAcks` = waiters - per collection instance
  const ackedIds = new Set<string | number>()
  const pendingAcks = new Map<
    string | number,
    {
      promise: Promise<void>
      resolve: () => void
      reject: (err: unknown) => void
    }
  >()

  const dbName = config.dbName || `app-db`
  const tableName =
    config.tableName || config.storeName || config.id || `collection`

  // Initialize Dexie database
  const db = new Dexie(dbName)
  db.version(1).stores({
    [tableName]: `&id, _updatedAt, _createdAt`, // Include our metadata fields for efficient sorting
  })

  const table = db.table(tableName)

  // Special ID for counter record (filtered out from user queries)
  const COUNTER_ID = `__dexie_counter__`

  // Write path state (separate from reactive layer)
  let writePathSubscription: Subscription | null = null
  let isOnline = typeof navigator !== `undefined` ? navigator.onLine : true
  let isSyncing = false
  // Track IDs currently being synced to prevent duplicate calls
  const syncingIds = new Set<string | number>()
  const retryState = new Map<
    string | number,
    {
      attempts: number
      timerId?: ReturnType<typeof setTimeout>
    }
  >()

  const awaitAckedIds = async (
    ids: Array<string | number>,
    timeoutMs = config.ackTimeoutMs || 2000
  ) => {
    const results: Array<Promise<void>> = []
    const timedOutIds: Array<string | number> = []

    for (const id of ids) {
      if (ackedIds.has(id)) {
        results.push(Promise.resolve())
        continue
      }

      const existing = pendingAcks.get(id)
      if (existing) {
        results.push(existing.promise)
        continue
      }

      let resolve!: () => void
      let reject!: (err: unknown) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })

      void promise.catch(() => {})

      pendingAcks.set(id, { promise, resolve, reject })

      const t = setTimeout(() => {
        if (!pendingAcks.has(id)) return
        pendingAcks.delete(id)
        debug(`awaitAckedIds:timeout`, { id: String(id) })
        timedOutIds.push(id)
        resolve()
      }, timeoutMs)

      void promise.finally(() => clearTimeout(t))

      results.push(promise)
    }

    await Promise.all(results)

    if (timedOutIds.length > 0) {
      throw new Error(
        `Timeout waiting for acked ids: ${timedOutIds.join(`, `)}`
      )
    }
  }

  const awaitIds = async (
    ids: Array<string | number>,
    timeoutMs = config.awaitTimeoutMs || 10000
  ): Promise<void> => {
    try {
      await awaitAckedIds(ids, config.ackTimeoutMs || 2000)
      return
    } catch {
      try {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
          const allSeen = ids.every((id) => seenIds.has(id))
          if (allSeen) return

          // Instead of checking database directly, check if data exists in DB
          // and give the reactive layer a chance to process it
          try {
            const bulkFn = table.bulkGet
            let rows: unknown
            if (typeof bulkFn === `function`) {
              rows = await bulkFn.call(table, ids)
            } else {
              rows = await Promise.all(ids.map((id) => table.get(id)))
            }
            const present = Array.isArray(rows) && rows.every((r) => r != null)
            if (present) {
              // Data exists in DB, trigger a refresh to ensure reactive layer processes it
              triggerRefresh()
              // Give the reactive layer a bit more time to process
              await new Promise((r) => setTimeout(r, 100))

              // Check again if the reactive layer has processed it
              const allSeenAfterRefresh = ids.every((id) => seenIds.has(id))
              if (allSeenAfterRefresh) return
            }
          } catch {}

          await new Promise((r) => setTimeout(r, 50))
        }
      } catch {}

      throw new Error(`Timeout waiting for IDs: ${ids.join(`, `)}`)
    }
  }

  // ============================================================================
  // Write Path (Local → Server Sync)
  // ============================================================================

  /**
   * Revert a failed operation silently after max retries exceeded
   */
  const revertOperation = async (
    id: string | number,
    operation: `create` | `update` | `delete`
  ) => {
    try {
      if (operation === `create`) {
        // New row was rejected - delete it entirely (never existed on server)
        await table.delete(id)
      } else if (operation === `delete`) {
        // Delete was rejected - unmark as deleted
        await table.update(id, { _deleted: false, _sentToServer: false })
      } else if (operation === `update`) {
        // Update was rejected - restore from backup
        const row = (await table.get(id)) as Record<string, unknown> | undefined
        if (row?._backup && Object.keys(row._backup as object).length > 0) {
          await table.update(id, {
            ...(row._backup as object),
            _backup: null,
            _modifiedColumns: [],
            _sentToServer: false,
          })
        } else {
          // No backup - just clear modification state
          await table.update(id, { _modifiedColumns: [], _sentToServer: false })
        }
      }
      debug(`writepath:revert`, { id: String(id), operation })
    } catch (err) {
      debug(`writepath:revert:error`, {
        id: String(id),
        operation,
        error: String(err),
      })
    }
  }

  /**
   * Handle sync error with exponential backoff retry
   */
  const handleSyncError = async (
    id: string | number,
    operation: `create` | `update` | `delete`,
    error: unknown
  ) => {
    const maxAttempts = config.syncRetryMaxAttempts ?? 5
    const baseDelay = config.syncRetryBaseDelayMs ?? 1000

    const state = retryState.get(id) || { attempts: 0 }
    state.attempts++

    if (state.attempts >= maxAttempts) {
      // Max retries exceeded - revert silently
      await revertOperation(id, operation)
      retryState.delete(id)
      debug(`writepath:maxretries`, {
        id: String(id),
        operation,
        attempts: state.attempts,
      })
      return
    }

    // Schedule retry with exponential backoff
    const delay = baseDelay * Math.pow(2, state.attempts - 1)
    state.timerId = setTimeout(() => {
      retryState.delete(id)
      void doSync()
    }, delay)
    retryState.set(id, state)

    // Reset _sentToServer so it gets picked up again
    await table.update(id, { _sentToServer: false })

    debug(`writepath:retry`, {
      id: String(id),
      operation,
      attempt: state.attempts,
      delay,
    })
  }

  /**
   * Main sync function - pushes unsynced rows to server via user handlers
   * Called directly by liveQuery when unsynced rows are detected (no debounce needed)
   */
  const doSync = async () => {
    if (!isOnline || isSyncing) {
      console.log(`[WritePath:skip]`, { isOnline, isSyncing })
      return
    }
    isSyncing = true

    try {
      const unsyncedRows = await table
        .filter((r) => needsSync(r) && r._sentToServer !== true)
        .toArray()

      console.log(`[WritePath:found]`, {
        count: unsyncedRows.length,
        ids: unsyncedRows.map((r) => config.getKey(r as TItem)),
      })

      for (const row of unsyncedRows) {
        const id = config.getKey(row as TItem)

        // Skip if already being synced (prevents duplicate calls from liveQuery)
        if (syncingIds.has(id)) {
          console.log(`[WritePath:skip-syncing]`, { id: String(id) })
          continue
        }

        // Local-only: created and deleted before sync - hard delete
        if (row._new && row._deleted) {
          await table.delete(id)
          retryState.delete(id)
          debug(`writepath:local-only-delete`, { id: String(id) })
          continue
        }

        // Determine operation type
        let operation: `create` | `update` | `delete`

        if (row._new) {
          operation = `create`
        } else if (row._deleted) {
          operation = `delete`
        } else if (
          Array.isArray(row._modifiedColumns) &&
          row._modifiedColumns.length > 0
        ) {
          operation = `update`
        } else {
          // No pending changes
          continue
        }

        // Mark as being synced to prevent duplicate calls
        syncingIds.add(id)

        // Mark as sent BEFORE calling handler
        await table.update(id, { _sentToServer: true })

        console.log(`[WritePath:calling-handler]`, {
          id: String(id),
          operation,
          _new: row._new,
          _deleted: row._deleted,
          _sentToServer: row._sentToServer,
          _modifiedColumns: row._modifiedColumns,
        })

        try {
          // Call user handler with simple signature
          // Strip internal Dexie fields before passing to user handlers
          const cleanedRow = stripDexieFields(row)

          if (operation === `create` && config.onInsert) {
            await config.onInsert(cleanedRow as TItem)
          } else if (operation === `update` && config.onUpdate) {
            const modifiedColumns = (row._modifiedColumns as string[]) || []
            // Only include the modified columns in changes (not entire row)
            const changes: Partial<TItem> = {}
            for (const col of modifiedColumns) {
              if (col in cleanedRow) {
                ;(changes as any)[col] = (cleanedRow as any)[col]
              }
            }
            await config.onUpdate(id, changes, modifiedColumns)
          } else if (operation === `delete` && config.onDelete) {
            await config.onDelete(id)
          } else {
            // No handler configured - just mark as synced
            console.log(`[WritePath:no-handler]`, { id: String(id), operation })
          }

          // Success - clear retry state and syncing flag
          retryState.delete(id)
          syncingIds.delete(id)
          console.log(`[WritePath:success]`, { id: String(id), operation })
        } catch (err) {
          // Handler threw - clear syncing flag and schedule retry with backoff
          syncingIds.delete(id)
          console.log(`[WritePath:error]`, {
            id: String(id),
            operation,
            error: String(err),
          })
          await handleSyncError(id, operation, err)
        }
      }
    } catch (err) {
      debug(`writepath:sync-error`, { error: String(err) })
    } finally {
      isSyncing = false
    }
  }

  // Schema validation helper following create-collection.md patterns
  const validateSchema = (item: unknown): TItem => {
    if (config.schema) {
      // Handle different schema validation patterns (Zod, etc.)
      const schema = config.schema as unknown as {
        parse?: (data: unknown) => TItem
        safeParse?: (data: unknown) => {
          success: boolean
          data?: TItem
          error?: unknown
        }
      }

      if (schema.parse) {
        try {
          return schema.parse(item)
        } catch (error) {
          throw new Error(
            `Schema validation failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      } else if (schema.safeParse) {
        const result = schema.safeParse(item)
        if (!result.success) {
          throw new Error(
            `Schema validation failed: ${JSON.stringify(result.error)}`
          )
        }
        return result.data!
      }
    }
    return item as TItem
  }

  // Data transformation helpers
  const parse = (raw: Record<string, unknown>): TItem => {
    // First strip our internal metadata fields
    const cleanedRaw = stripDexieFields(raw)

    let parsed: unknown = cleanedRaw

    // Apply codec parse if provided
    if (config.codec?.parse) {
      parsed = config.codec.parse(cleanedRaw as never)
    }

    // Then validate against schema - this is where TanStack DB handles validation
    // Schema validation is handled automatically by TanStack DB during insert/update operations
    // The schema is primarily used for type inference and automatic validation
    const validated = validateSchema(parsed)

    return validated
  }

  const serialize = (
    item: TItem,
    action: keyof typeof ActionTypes,
    fromServer: boolean = false,
    existingRow?: Record<string, unknown>
  ): Record<string, unknown> => {
    let serialized: unknown = item

    // Apply codec serialize
    if (config.codec?.serialize) {
      serialized = config.codec.serialize(item)
    } else {
      serialized = item
    }

    // Add our metadata for efficient syncing and conflict resolution
    // Pass existingRow for merge logic when fromServer=true
    return addDexieMetadata(
      serialized as Record<string, unknown>,
      action,
      fromServer,
      existingRow
    )
  }

  // Track refresh triggers for manual refresh capability
  let refreshTrigger = 0
  const triggerRefresh = () => {
    refreshTrigger++
  }

  // Shallow comparison helper for efficient change detection
  const shallowEqual = (obj1: any, obj2: any): boolean => {
    if (obj1 === obj2) return true
    if (!obj1 || !obj2) return false
    if (typeof obj1 !== `object` || typeof obj2 !== `object`) return false

    const keys1 = Object.keys(obj1)
    const keys2 = Object.keys(obj2)

    if (keys1.length !== keys2.length) return false

    for (const key of keys1) {
      if (obj1[key] !== obj2[key]) return false
    }

    return true
  }

  /**
   * "sync"
   * Sync between the local Dexie table and the in-memory TanStack DB
   * collection. Not a remote/server sync — keeps local reactive state
   * and in-memory collection consistent.
   */
  const sync = (params: Parameters<SyncConfig<TItem>[`sync`]>[0]) => {
    const { begin, write, commit, markReady } = params

    // Track the previous snapshot to implement proper diffing
    let previousSnapshot = new Map<string | number, TItem>()

    // Batched initial sync configuration
    const syncBatchSize = config.syncBatchSize || 1000

    // Initial sync state
    let isInitialSyncComplete = false
    let lastUpdatedAt: number | undefined
    let hasMarkedReady = false
    let subscription: Subscription | null = null
    let electricUnsubscribe: (() => void) | null = null

    const performInitialSync = async () => {
      // initial sync started

      begin()
      let totalProcessed = 0

      for (;;) {
        // Query next batch using _updatedAt for efficient pagination
        let batchRecords: Array<any>

        if (lastUpdatedAt) {
          // Continue from where we left off using where().above()
          batchRecords = await table
            .where(`_updatedAt`)
            .above(lastUpdatedAt)
            .limit(syncBatchSize)
            .toArray()
        } else {
          // First batch - get oldest records, or all records if no _updatedAt exists
          try {
            batchRecords = await table
              .orderBy(`_updatedAt`)
              .limit(syncBatchSize)
              .toArray()
          } catch {
            // Fallback for records without _updatedAt (pre-existing data)
            batchRecords = await table.limit(syncBatchSize).toArray()
          }
        }

        if (batchRecords.length === 0) {
          // No more records, initial sync is complete
          break
        }

        // Process this batch
        const batchSnapshot = new Map<string | number, TItem>()

        for (const record of batchRecords) {
          // Skip counter record
          if (record.id === COUNTER_ID) continue
          // Skip deleted records (soft-deleted items should not appear in collection)
          if (record._deleted === true) continue

          let item: TItem
          try {
            item = parse(record)
          } catch (err) {
            // Skip invalid records instead of letting the sync throw
            debug(`parse:skip`, { id: record?.id, error: err })
            continue
          }

          const key = config.getKey(item)

          // Track this ID as seen (for optimistic state management)
          seenIds.set(key, Date.now())

          // Mark ack for this id (reactive layer has observed it)
          ackedIds.add(key)
          const pending = pendingAcks.get(key)
          if (pending) {
            try {
              pending.resolve()
            } catch {}
            pendingAcks.delete(key)
          }

          batchSnapshot.set(key, item)

          // Update lastUpdatedAt for next batch (use our metadata field)
          const updatedAt = record._updatedAt
          if (updatedAt && (!lastUpdatedAt || updatedAt > lastUpdatedAt)) {
            lastUpdatedAt = updatedAt
          }
        }

        // Write this batch to TanStack DB
        for (const [, item] of batchSnapshot) {
          write({
            type: `insert`,
            value: item,
          })
          previousSnapshot.set(config.getKey(item), item)
        }

        totalProcessed += batchRecords.length

        // If we got less than batch size, we're done
        if (batchRecords.length < syncBatchSize) {
          break
        }
      }

      commit()
      isInitialSyncComplete = true

      debug(`sync:initial-complete`, { totalProcessed })

      // Add memory usage warning for large collections
      if (totalProcessed > 5000) {
        debug(`sync:large-collection`, { totalProcessed })
      }
    }

    // Start the sync process
    const startSync = async () => {
      // Perform initial sync first, outside of liveQuery
      await performInitialSync()

      // Start the liveQuery subscription to monitor ongoing changes
      startLiveQuery()

      // Mark as ready after initial sync completes
      if (!hasMarkedReady) {
        try {
          markReady()
        } finally {
          hasMarkedReady = true
        }
      }
    }

    // Start live monitoring of changes (after initial sync)
    const startLiveQuery = () => {
      subscription = liveQuery(async () => {
        void refreshTrigger

        if (!isInitialSyncComplete) {
          return previousSnapshot
        }

        const records = await table.toArray()

        const snapshot = new Map<string | number, TItem>()

        for (const record of records) {
          // Skip counter record
          if (record.id === COUNTER_ID) continue

          // Skip deleted records (soft-deleted items should not appear in collection)
          if (record._deleted === true) continue

          let item: TItem
          try {
            item = parse(record)
          } catch (err) {
            // Skip invalid records instead of letting liveQuery throw
            console.error(
              `[Dexie] liveQuery: SKIPPING record due to parse error`,
              {
                id: record?.id,
                record,
                error: err,
              }
            )
            continue
          }

          const key = config.getKey(item)

          // Track this ID as seen (for optimistic state management)
          seenIds.set(key, Date.now())

          // Mark ack for this id (reactive layer has observed it)
          ackedIds.add(key)
          const pending = pendingAcks.get(key)
          if (pending) {
            try {
              pending.resolve()
            } catch {}
            pendingAcks.delete(key)
          }

          snapshot.set(key, item)
        }

        return snapshot
      }).subscribe({
        next: (currentSnapshot) => {
          // Skip processing during initial sync - it's handled separately
          if (!isInitialSyncComplete) {
            // Mark ready after initial sync
            if (!hasMarkedReady) {
              try {
                markReady()
              } finally {
                hasMarkedReady = true
              }
            }
            return
          }

          begin()

          for (const [key, item] of currentSnapshot) {
            if (previousSnapshot.has(key)) {
              const previousItem = previousSnapshot.get(key)
              // NOTE : we are using any because we are attatching meta fields for dexie similar to rxdb
              const currentUpdatedAt = (item as any)._updatedAt
              const previousUpdatedAt = (previousItem as any)._updatedAt

              let hasChanged = false
              if (currentUpdatedAt && previousUpdatedAt) {
                hasChanged = currentUpdatedAt !== previousUpdatedAt
              } else {
                hasChanged = !shallowEqual(previousItem, item)
              }

              if (hasChanged) {
                write({
                  type: `update`,
                  value: item,
                })
              }
            } else {
              // New item, this is an insert
              write({
                type: `insert`,
                value: item,
              })
            }
          }

          // Process deletions - items that were in previous but not in current
          for (const [key, item] of previousSnapshot) {
            if (!currentSnapshot.has(key)) {
              write({
                type: `delete`,
                value: item, // Use the full item for deletion
              })
            }
          }

          // Update our snapshot for the next comparison
          previousSnapshot = new Map(currentSnapshot)

          commit()

          // live commit completed

          // After the first emission/commit, mark the collection as ready so
          // callers awaiting stateWhenReady() observe the initial data.
          if (!hasMarkedReady) {
            try {
              markReady()
            } finally {
              hasMarkedReady = true
            }
          }
        },
        error: (error) => {
          debug(`sync:live-error`, { error })
          // Still mark ready even on error (as per create-collection.md)
          if (!hasMarkedReady) {
            try {
              markReady()
            } finally {
              hasMarkedReady = true
            }
          }
        },
      })
      // Only initialize Electric stream if shapeUrl is provided
      if (config.shapeUrl) {
        // Generate a unique shape name from the URL for state persistence
        const shapeName = config.shapeUrl.replace(/[^a-zA-Z0-9]/g, `_`)

        // Load persisted state to resume from last position
        const persistedState = loadShapeState(shapeName)
        if (persistedState) {
          debug(`[Electric:${shapeName}] Resuming from persisted state`)
        }

        // Type assertion needed: Electric returns Row but we know it matches TItem
        const stream = new ShapeStream<TItem & Row>({
          url: config.shapeUrl,
          // Resume from persisted state if available
          ...(persistedState && {
            handle: persistedState.handle,
            offset: persistedState.offset as `-1` | `${number}_${number}`,
          }),
        })

        // Subscribe to Electric stream for server-side changes
        electricUnsubscribe = stream.subscribe(
          async (messages) => {
            for (const message of messages) {
              if (isChangeMessage(message)) {
                const { operation } = message.headers
                const row = message.value

                // Validate row has an id
                if (
                  !row.id ||
                  (typeof row.id !== `string` && typeof row.id !== `number`)
                ) {
                  debug(
                    `[Electric:${shapeName}] Skipping message with invalid id:`,
                    row
                  )
                  continue
                }

                try {
                  console.log(
                    `[Electric:${shapeName}] Operation: ${operation}`,
                    row
                  )
                  if (operation === `insert`) {
                    await insertLocally(row as TItem, true)
                  } else if (operation === `update`) {
                    await updateLocally(row.id, row as TItem, true)
                  } else if (operation === `delete`) {
                    console.log(
                      `[Electric:${shapeName}] DELETING item:`,
                      row.id
                    )
                    await deleteLocally(row.id, true)
                  }
                } catch (err) {
                  console.error(`[Electric:${shapeName}] Sync error:`, err)
                }
              } else if (isControlMessage(message)) {
                if (message.headers.control === `up-to-date`) {
                  // Save current position for resuming later
                  const handle = stream.shapeHandle
                  const offset = stream.lastOffset
                  if (handle && offset) {
                    saveShapeState(shapeName, handle, offset)
                    debug(
                      `[Electric:${shapeName}] Saved shape state at offset ${offset}`
                    )
                  }
                } else if (message.headers.control === `must-refetch`) {
                  debug(
                    `[Electric:${shapeName}] Must refetch - server requested full resync`
                  )
                  clearShapeState(shapeName)
                }
              }
            }
          },
          (error) => {
            debug(`[Electric:${shapeName}] Stream error:`, error)
          }
        )
      }

      // Write path watcher - separate liveQuery for unsynced rows
      // Calls doSync directly when changes detected (no debounce - liveQuery is already reactive)
      writePathSubscription = liveQuery(async () => {
        const unsyncedRows = await table
          .filter((r) => needsSync(r) && r._sentToServer !== true)
          .toArray()
        // Also exclude items currently being synced
        const filteredRows = unsyncedRows.filter(
          (r) => !syncingIds.has(config.getKey(r as TItem))
        )
        return filteredRows.length
      }).subscribe({
        next: (count) => {
          console.log(`[WritePath:watch]`, {
            count,
            isOnline,
            isSyncing,
            syncingIds: Array.from(syncingIds),
          })
          if (count > 0 && isOnline) {
            void doSync()
          }
        },
        error: (err) => {
          console.error(`[WritePath:watch:error]`, { error: String(err) })
        },
      })

      // Online/offline handling
      if (typeof window !== `undefined`) {
        const handleOffline = () => {
          isOnline = false
          // Pause Electric stream
          if (electricUnsubscribe) {
            electricUnsubscribe()
            electricUnsubscribe = null
          }
          debug(`sync:offline`)
        }

        const handleOnline = () => {
          isOnline = true
          // Resume Electric stream - reinitialize if shapeUrl is configured
          if (config.shapeUrl && !electricUnsubscribe) {
            const shapeName = config.shapeUrl.replace(/[^a-zA-Z0-9]/g, `_`)
            const persistedState = loadShapeState(shapeName)

            const stream = new ShapeStream<TItem & Row>({
              url: config.shapeUrl,
              ...(persistedState && {
                handle: persistedState.handle,
                offset: persistedState.offset as `-1` | `${number}_${number}`,
              }),
            })

            electricUnsubscribe = stream.subscribe(
              async (messages) => {
                for (const message of messages) {
                  if (isChangeMessage(message)) {
                    const { operation } = message.headers
                    const row = message.value

                    if (
                      !row.id ||
                      (typeof row.id !== `string` && typeof row.id !== `number`)
                    ) {
                      continue
                    }

                    try {
                      if (operation === `insert`) {
                        await insertLocally(row as TItem, true)
                      } else if (operation === `update`) {
                        await updateLocally(row.id, row as TItem, true)
                      } else if (operation === `delete`) {
                        await deleteLocally(row.id, true)
                      }
                    } catch (err) {
                      debug(
                        `[Electric:${shapeName}] Sync error on reconnect:`,
                        {
                          error: String(err),
                        }
                      )
                    }
                  } else if (isControlMessage(message)) {
                    if (message.headers.control === `up-to-date`) {
                      const handle = stream.shapeHandle
                      const offset = stream.lastOffset
                      if (handle && offset) {
                        saveShapeState(shapeName, handle, offset)
                      }
                    } else if (message.headers.control === `must-refetch`) {
                      clearShapeState(shapeName)
                    }
                  }
                }
              },
              (error) => {
                debug(`[Electric:${shapeName}] Stream error on reconnect:`, {
                  error: String(error),
                })
              }
            )
          }
          // Trigger write path sync
          void doSync()
          debug(`sync:online`)
        }

        window.addEventListener(`offline`, handleOffline)
        window.addEventListener(`online`, handleOnline)

        // Store handlers for cleanup
        ;(cleanup as any).onlineHandler = handleOnline
        ;(cleanup as any).offlineHandler = handleOffline
      }
    }

    // Cleanup function reference for storing handlers
    const cleanup = () => {
      // 1. Reactive layer
      if (subscription) {
        subscription.unsubscribe()
      }

      // 2. Electric stream
      if (electricUnsubscribe) {
        electricUnsubscribe()
      }

      // 3. Write path
      if (writePathSubscription) {
        writePathSubscription.unsubscribe()
      }
      for (const state of retryState.values()) {
        if (state.timerId) clearTimeout(state.timerId)
      }
      retryState.clear()

      // 4. Online/offline listeners
      if (typeof window !== `undefined`) {
        const onlineHandler = (cleanup as any).onlineHandler
        const offlineHandler = (cleanup as any).offlineHandler
        if (onlineHandler) window.removeEventListener(`online`, onlineHandler)
        if (offlineHandler)
          window.removeEventListener(`offline`, offlineHandler)
      }
    }

    // Start the sync process
    startSync()

    // Return cleanup function (critical requirement from create-collection.md)
    return cleanup
  }

  // Built-in mutation handlers (Pattern B) - we implement these directly using Dexie APIs
  const onInsert = async (insertParams: InsertMutationFnParams<TItem>) => {
    // Ensure the collection's sync is running so the reactive layer
    // (liveQuery) can observe writes and ack them. Use the public
    // startSyncImmediate() helper to avoid accessing internals.
    insertParams.collection.startSyncImmediate()

    const mutations = insertParams.transaction.mutations

    // Perform bulk operation using Dexie transaction
    // Fetch existing rows inside transaction for consistency (handles idempotent retries)
    const txP = db.transaction(`rw`, table, async () => {
      const keys = mutations.map((m) => m.key)
      const existingRows = await table.bulkGet(keys)
      const existingRowMap = new Map<string | number, Record<string, unknown>>()
      for (let i = 0; i < keys.length; i++) {
        if (existingRows[i]) {
          existingRowMap.set(
            keys[i],
            existingRows[i] as Record<string, unknown>
          )
        }
      }

      const items = mutations.map((mutation) => {
        const existingRow = existingRowMap.get(mutation.key)
        // Use UPDATE action if row exists (idempotent retry), INSERT otherwise
        const action = existingRow ? ActionTypes.UPDATE : ActionTypes.INSERT
        const item = serialize(mutation.modified, action, false, existingRow)
        return {
          ...item,
          id: mutation.key,
        } as Record<string, unknown> & { id: string | number }
      })

      console.log(
        `[Dexie] onInsert: inserting ${items.length} items to table "${tableName}"`,
        items
      )
      await table.bulkPut(items)
      console.log(`[Dexie] onInsert: bulkPut completed`)
    })
    // Attach error logging to detect silent failures
    void txP.catch((err) => {
      console.error(`[Dexie] onInsert transaction failed:`, err)
    })
    await txP
    await db.table(tableName).count()

    // Optimistically mark IDs as seen immediately after write so callers
    // waiting with `awaitIds` don't have to wait for the reactive layer
    // to observe the change. Do not block the insert handler on the reactive
    // layer ack — awaiting here can cause races between multiple instances
    // where a second insert observes the first insert and throws a DuplicateKey
    // error. The reactive layer will still ack and update synced state.
    const ids = mutations.map((m) => m.key)

    const now = Date.now()
    for (const id of ids) seenIds.set(id, now)
    triggerRefresh()

    // Write path watcher will detect unsynced rows and call config.onInsert
    // No need to call handler here - separation of concerns

    return ids
  }

  const onUpdate = async (updateParams: UpdateMutationFnParams<TItem>) => {
    updateParams.collection.startSyncImmediate()
    const mutations = updateParams.transaction.mutations
    debug(`onUpdate:mutations`, { count: mutations.length })

    const txUP = db.transaction(`rw`, table, async () => {
      for (const mutation of mutations) {
        const key = mutation.key
        // Fetch existing row inside transaction for consistency
        const existingRow = (await table.get(key)) as
          | Record<string, unknown>
          | undefined

        // Store backup of current values BEFORE modification (for revert on sync rejection)
        // Only backup if row exists and is not _new (new rows have no server state to revert to)
        let backup: Record<string, unknown> | null = null
        if (existingRow && !existingRow._new) {
          const changedKeys = Object.keys(mutation.changes || {}).filter(
            (k) => !k.startsWith(`_`)
          )
          // Preserve existing backup values (first modification wins)
          backup = { ...((existingRow._backup as object) || {}) }
          for (const k of changedKeys) {
            if (!(k in backup)) {
              backup[k] = existingRow[k]
            }
          }
        }

        if (config.rowUpdateMode === `full`) {
          const item = serialize(
            mutation.modified,
            ActionTypes.UPDATE,
            false,
            existingRow
          )
          const updateItem = {
            ...item,
            _backup: backup,
            id: key,
          } as Record<string, unknown> & { id: string | number }
          debug(`onUpdate:full`, { key: String(key) })
          await table.put(updateItem)
        } else {
          const changes = serialize(
            mutation.changes as TItem,
            ActionTypes.UPDATE,
            false,
            existingRow
          )
          // Include backup in the update
          const changesWithBackup = {
            ...changes,
            _backup: backup,
          }
          debug(`onUpdate:partial`, { key: String(key) })
          await table.update(key, changesWithBackup)
        }
      }
    })
    void txUP.catch((err) => {
      console.error(`[Dexie] onUpdate transaction failed:`, err)
    })
    await txUP
    const ids = mutations.map((m) => m.key)
    const now = Date.now()
    for (const id of ids) seenIds.set(id, now)
    triggerRefresh()

    // Write path watcher will detect unsynced rows and call config.onUpdate
    // No need to call handler here - separation of concerns

    return ids
  }

  const onDelete = async (deleteParams: DeleteMutationFnParams<TItem>) => {
    // Ensure sync is started so deletions are observed by liveQuery
    deleteParams.collection.startSyncImmediate()

    const mutations = deleteParams.transaction.mutations
    const ids = mutations.map((m) => m.key)

    // Soft delete: set _deleted to true instead of removing the record
    // Fetch existing rows inside transaction for consistency
    const txD = db.transaction(`rw`, table, async () => {
      for (const mutation of mutations) {
        const existingRow = (await table.get(mutation.key)) as
          | Record<string, unknown>
          | undefined
        if (!existingRow) continue

        // Use serialize with all args for proper metadata handling
        const item = serialize(
          existingRow as TItem,
          ActionTypes.DELETE,
          false,
          existingRow
        )

        if (item._new) {
          // New items that haven't been synced can be hard-deleted
          await table.delete(mutation.key)
        } else {
          // Use the full serialized result for proper _modifiedColumns, _backup tracking
          await table.put({ ...item, id: mutation.key })
        }
      }
    })
    void txD.catch((err) => {
      console.error(`[Dexie] onDelete transaction failed:`, err)
    })
    await txD

    // Mark as seen (item still exists, just marked deleted)
    const now = Date.now()
    for (const id of ids) {
      seenIds.set(id, now)
    }
    triggerRefresh()

    // Write path watcher will detect unsynced rows and call config.onDelete
    // No need to call handler here - separation of concerns

    return ids
  }

  /**
   * Insert an item locally to both IndexedDB and TanStack DB memory.
   * Does NOT trigger the user's onInsert handler.
   *
   * Uses put internally, so it will update existing items with the same key.
   *
   * @param item - The item to insert
   * @returns Promise that resolves when the item is persisted and visible in memory
   */
  const insertLocally = async (
    item: TItem,
    fromServer: boolean = false
  ): Promise<void> => {
    // Validate with schema if provided
    const validated = validateSchema(item)
    const key = config.getKey(validated)

    // Get existing row for merge logic (only needed when fromServer=true)
    const existingRow = fromServer ? await table.get(key) : undefined

    // Serialize handles all merge/conflict resolution via addDexieMetadata
    const serialized = serialize(
      validated,
      existingRow ? ActionTypes.UPDATE : ActionTypes.INSERT,
      fromServer,
      existingRow as Record<string, unknown> | undefined
    )

    try {
      console.log(`[Dexie] insertLocally: writing to table "${tableName}"`, {
        key,
        fromServer,
        serialized,
      })
      await db.transaction(`rw`, table, async () => {
        await table.put({ ...serialized, id: key })
      })
      console.log(`[Dexie] insertLocally: write completed for key "${key}"`)
      // Verify the write
      const count = await table.count()
      const written = await table.get(key)
      console.log(
        `[Dexie] insertLocally: verification - table count: ${count}, written record:`,
        written
      )
    } catch (error) {
      console.error(`[Dexie] insertLocally:error`, {
        key,
        error: String(error),
      })
      throw new Error(
        `Failed to insert item locally: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Mark as seen and ack (for TanStack DB sync)
    seenIds.set(key, Date.now())
    ackedIds.add(key)
    const pending = pendingAcks.get(key)
    if (pending) {
      pending.resolve()
      pendingAcks.delete(key)
    }

    triggerRefresh()

    // Give liveQuery a moment to process the change
    await new Promise((r) => setTimeout(r, 10))
  }

  /**
   * Update an item locally in both IndexedDB and TanStack DB memory.
   * Does NOT trigger the user's onUpdate handler.
   *
   * @param id - The ID of the item to update
   * @param item - The updated item
   * @returns Promise that resolves when the item is persisted
   */
  const updateLocally = async (
    id: string | number,
    item: TItem,
    fromServer: boolean = false
  ): Promise<void> => {
    // Get existing row for merge logic
    const existingRow = await table.get(id)

    // Serialize handles all merge/conflict resolution via addDexieMetadata
    const serialized = serialize(
      item,
      ActionTypes.UPDATE,
      fromServer,
      existingRow as Record<string, unknown> | undefined
    )

    try {
      let updated = 0
      await db.transaction(`rw`, table, async () => {
        if (config.rowUpdateMode === `full` || fromServer) {
          // Server updates always use put for full replacement after merge
          await table.put({ ...serialized, id })
          updated = 1
        } else {
          updated = await table.update(id, serialized)
        }
      })

      // In partial mode (local only), throw if item doesn't exist
      if (!fromServer && config.rowUpdateMode !== `full` && updated === 0) {
        throw new Error(`Item with id "${id}" not found`)
      }
    } catch (error) {
      debug(`updateLocally:error`, { id, error: String(error) })
      throw new Error(
        `Failed to update item locally: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Mark as seen and ack (for TanStack DB sync)
    seenIds.set(id, Date.now())
    ackedIds.add(id)
    const pending = pendingAcks.get(id)
    if (pending) {
      pending.resolve()
      pendingAcks.delete(id)
    }

    triggerRefresh()

    // Give liveQuery a moment to process the change
    await new Promise((r) => setTimeout(r, 10))
  }

  /**
   * Delete an item locally from both IndexedDB and TanStack DB memory.
   * Does NOT trigger the user's onDelete handler.
   *
   * When fromServer=true (Electric sync), server delete always wins.
   * Any local pending changes are discarded - the server is authoritative.
   *
   * @param id - The ID of the item to delete
   * @param fromServer - If true, this is a server-initiated delete (always wins)
   * @returns Promise that resolves when the item is deleted
   */
  const deleteLocally = async (
    id: string | number,
    fromServer: boolean = false
  ): Promise<void> => {
    // Check if item exists (for debugging)
    if (fromServer) {
      const localRow = await table.get(id)
      if (!localRow) {
        debug(`deleteLocally:server: Item ${id} already deleted locally`)
        return // Already deleted locally, nothing to do
      }
      // Server delete always wins - proceed with deletion regardless of local state
      debug(`deleteLocally:server: Deleting ${id} (server wins)`)
    }

    try {
      await db.transaction(`rw`, table, async () => {
        await table.delete(id)
      })
    } catch (error) {
      debug(`deleteLocally:error`, { id, error: String(error) })
      throw new Error(
        `Failed to delete item locally: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // Remove from tracking
    seenIds.delete(id)
    ackedIds.delete(id)
    pendingAcks.delete(id)

    triggerRefresh()
  }

  const utils: DexieUtils = {
    getTable: () => table as Table<Record<string, unknown>, string | number>,
    awaitIds,
    refresh: triggerRefresh,
    refetch: async () => {
      triggerRefresh()
      await new Promise((r) => setTimeout(r, 20))
    },
    insertLocally,
    updateLocally,
    deleteLocally,
  }

  return {
    id: config.id,
    schema: config.schema,
    getKey: config.getKey,
    rowUpdateMode: config.rowUpdateMode ?? `partial`,
    sync: { sync },
    onInsert,
    onUpdate,
    onDelete,
    utils,
  } as CollectionConfig<TItem, string | number> & { utils: DexieUtils }
}
