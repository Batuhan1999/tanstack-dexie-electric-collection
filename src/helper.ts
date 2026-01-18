const RESERVED_DEXIE_FIELDS = new Set([
  `_dexieMeta`,
  `_updatedAt`,
  `_createdAt`,
])

const SYNC_STATE_FIELDS = new Set([
  `_new`,
  `_sentToServer`,
  `_modifiedColumns`,
  `_backup`,
  `_deleted`,
])

export enum ActionTypes {
  INSERT = `INSERT`,
  UPDATE = `UPDATE`,
  DELETE = `DELETE`,
}

/**
 * Check if a row is in synced state (no pending local changes)
 */
export function isSynced(row: Record<string, unknown>): boolean {
  return (
    row._new !== true &&
    row._deleted !== true &&
    row._sentToServer !== true &&
    (!Array.isArray(row._modifiedColumns) || row._modifiedColumns.length === 0)
  )
}

/**
 * Check if record needs to be synced (has pending local changes)
 * Inverse of isSynced
 */
export function needsSync(row: Record<string, unknown>): boolean {
  return !isSynced(row)
}

export function stripDexieFields<T extends Record<string, any>>(
  obj: T | any
): T {
  if (!obj) return obj
  const out: any = Array.isArray(obj) ? [] : {}
  for (const k of Object.keys(obj)) {
    if (RESERVED_DEXIE_FIELDS.has(k)) continue
    if (SYNC_STATE_FIELDS.has(k)) continue
    out[k] = obj[k]
  }
  return out as T
}

/**
 * Helper to get timestamp value from various formats
 */
function getTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === `string`) return new Date(value).getTime()
  if (typeof value === `number`) return value
  return 0
}

/**
 * Add Dexie metadata fields for sync state tracking.
 * Handles all merge/conflict resolution logic when data comes from server.
 *
 * @param obj - The data object to add metadata to
 * @param action - The type of action (INSERT, UPDATE, DELETE)
 * @param fromServer - If true, marks data as synced (from server). If false, marks as pending local change.
 * @param existingRow - The existing local row (if any) for conflict resolution when fromServer=true
 */
export function addDexieMetadata<T extends Record<string, any>>(
  obj: T,
  action: keyof typeof ActionTypes,
  fromServer: boolean = false,
  existingRow?: Record<string, any>
): T & { _updatedAt: number; _createdAt?: number } {
  const now = Date.now()

  // For server data: use Last Write Wins (LWW) based on timestamps
  if (fromServer) {
    // No existing local row - just insert with synced state
    if (!existingRow) {
      const result = { ...obj } as any

      // Preserve server's timestamps if present, otherwise use now
      if (!result._updatedAt && !result.updatedAt) {
        result._updatedAt = now
      } else if (result.updatedAt && !result._updatedAt) {
        result._updatedAt = getTimestamp(result.updatedAt)
      }

      result._new = false
      result._deleted = action === ActionTypes.DELETE
      result._sentToServer = false
      result._modifiedColumns = []
      result._backup = null

      if (action === ActionTypes.INSERT && !result._createdAt) {
        result._createdAt = result._updatedAt || now
      }

      return result
    }

    // Existing local row - merge with LWW conflict resolution
    const localIsSynced = isSynced(existingRow)

    // Case 1: Local is synced - accept server data
    // Case 2: We sent to server (_sentToServer=true) - accept server confirmation
    // Case 3: Local was _new but server now has it - accept server data
    if (localIsSynced || existingRow._sentToServer || existingRow._new) {
      const result = { ...existingRow, ...obj } as any

      if (!result._updatedAt && !result.updatedAt) {
        result._updatedAt = now
      } else if (result.updatedAt && !result._updatedAt) {
        result._updatedAt = getTimestamp(result.updatedAt)
      }

      result._new = false
      result._deleted = action === ActionTypes.DELETE
      result._sentToServer = false
      result._modifiedColumns = []
      result._backup = null

      return result
    }

    // Compare timestamps to decide winner (LWW)
    const serverTime = getTimestamp(
      (obj as Record<string, unknown>).updatedAt ??
        (obj as Record<string, unknown>)._updatedAt
    )
    const localTime = getTimestamp(
      existingRow.updatedAt ?? existingRow._updatedAt
    )

    // Server data is newer - accept it and discard local changes
    if (serverTime > localTime) {
      const result = { ...existingRow, ...obj } as any

      if (!result._updatedAt) {
        result._updatedAt = serverTime || now
      }

      result._new = false
      result._deleted = action === ActionTypes.DELETE
      result._sentToServer = false
      result._modifiedColumns = []
      result._backup = null

      return result
    }

    // Local data is newer - preserve modified columns, merge unmodified from server
    const modifiedColumns = (existingRow._modifiedColumns as string[]) || []
    const result = { ...existingRow } as any

    for (const [key, value] of Object.entries(obj)) {
      if (key === `id` || key.startsWith(`_`)) continue
      // Only accept server value for columns NOT locally modified
      if (!modifiedColumns.includes(key)) {
        result[key] = value
      }
    }

    // Keep local pending state since we have uncommitted changes
    return result
  }

  // Local data - mark as pending change
  // Calculate modified columns BEFORE adding metadata - only external fields
  const externalModifiedColumns = Object.keys(obj).filter(
    (k) => !k.startsWith(`_`)
  )

  const result = { ...obj } as any
  result._updatedAt = now

  if (action === ActionTypes.INSERT) {
    result._createdAt = now
    result._new = true
    result._modifiedColumns = externalModifiedColumns
    result._backup = null
    result._sentToServer = false
    result._deleted = false
  }

  if (action === ActionTypes.UPDATE) {
    // Only track external fields that were actually modified
    result._modifiedColumns = externalModifiedColumns
    // Backup stores original values from existingRow for revert on rejection
    // Note: backup should be set before sync, not here - set to null for now
    result._backup = null
    result._sentToServer = false
    result._deleted = false
  }

  if (action === ActionTypes.DELETE) {
    result._modifiedColumns = externalModifiedColumns
    result._backup = null
    result._sentToServer = false
    result._deleted = true
  }

  return result
}
