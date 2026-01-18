# TanStack Dexie Electric Collection

A Dexie.js collection adapter for TanStack DB with **Electric SQL real-time sync**, offline-first persistence, automatic write path synchronization, and conflict resolution.

## Features

- 🔄 **Electric SQL Integration** - Real-time server sync via ShapeStream
- 💾 **Offline-First** - Full IndexedDB persistence via Dexie.js
- ⚡ **Auto Write Path** - Automatically syncs local changes to server
- 🔁 **Retry with Backoff** - Exponential backoff for failed syncs
- 🤝 **Conflict Resolution** - Last Write Wins (LWW) strategy
- 📡 **Online/Offline Handling** - Pauses sync when offline, resumes when online
- 🗑️ **Soft Deletes** - Proper delete synchronization with `_deleted` flag
- 📝 **Modified Columns Tracking** - Only sends changed fields on updates
- ↩️ **Revert on Failure** - Automatic rollback when server rejects changes

## Installation

```bash
npm install tanstack-dexie-electric-collection @tanstack/react-db dexie
```

## Quick Start

```typescript
import { createCollection } from "@tanstack/react-db"
import { dexieCollectionOptions } from "tanstack-dexie-electric-collection"
import { z } from "zod"

const noteSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export const notesCollection = createCollection(
  dexieCollectionOptions({
    id: "notes",
    schema: noteSchema,
    getKey: (item) => item.id,
    dbName: "my-app",
    tableName: "notes",
    
    // Electric SQL real-time sync (optional)
    shapeUrl: "http://localhost:3001/api/notes",
    
    // Server persistence handlers
    onInsert: async (item) => {
      await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      })
    },
    onUpdate: async (id, changes, modifiedColumns) => {
      await fetch("/api/notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...changes }),
      })
    },
    onDelete: async (id) => {
      await fetch("/api/notes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
    },
  })
)
```

## Configuration Options

### Required

| Option | Type | Description |
|--------|------|-------------|
| `getKey` | `(item) => string \| number` | Function to extract unique key from item |

### Database

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | `string` | - | Collection identifier (used as table name if not specified) |
| `dbName` | `string` | `'app-db'` | Dexie database name |
| `tableName` | `string` | `id` | Dexie table name |
| `schema` | `ZodSchema` | - | Schema for validation and type inference |

### Electric SQL Sync

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `shapeUrl` | `string` | - | Electric ShapeStream URL for real-time sync |

### Server Persistence Handlers

| Option | Type | Description |
|--------|------|-------------|
| `onInsert` | `(item) => Promise<any>` | Called when local insert needs server sync |
| `onUpdate` | `(id, changes, modifiedColumns) => Promise<any>` | Called when local update needs server sync |
| `onDelete` | `(id) => Promise<any>` | Called when local delete needs server sync |

### Write Path Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `syncRetryMaxAttempts` | `number` | `10` | Max retry attempts before giving up |
| `syncRetryBaseDelayMs` | `number` | `1000` | Base delay for exponential backoff |

### Sync Tuning

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `syncBatchSize` | `number` | `1000` | Batch size for initial sync |
| `ackTimeoutMs` | `number` | `2000` | Acknowledgment timeout |
| `awaitTimeoutMs` | `number` | `10000` | Await timeout for operations |
| `rowUpdateMode` | `'partial' \| 'full'` | `'partial'` | How updates are applied |

### Data Transformation

| Option | Type | Description |
|--------|------|-------------|
| `codec.parse` | `(stored) => item` | Transform when reading from Dexie |
| `codec.serialize` | `(item) => stored` | Transform when writing to Dexie |

## How It Works

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   TanStack DB   │────▶│   Dexie.js      │────▶│   IndexedDB     │
│   (In-Memory)   │◀────│   (Adapter)     │◀────│   (Storage)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               │ Write Path (auto-sync)
                               ▼
                        ┌─────────────────┐
                        │  Your Server    │
                        │  (via handlers) │
                        └─────────────────┘
                               │
                               │ Electric ShapeStream
                               ▼
                        ┌─────────────────┐
                        │  Electric SQL   │
                        │  (Real-time)    │
                        └─────────────────┘
```

### Write Path Flow

1. **Local Change** - User makes a change via TanStack DB
2. **Dexie Write** - Change is immediately persisted to IndexedDB
3. **Write Path Watcher** - `liveQuery` detects unsynced rows (`_sentToServer: false`)
4. **Server Sync** - Calls your `onInsert`/`onUpdate`/`onDelete` handler
5. **Success** - Marks row as synced, clears `_modifiedColumns` and `_backup`
6. **Failure** - Retries with exponential backoff, reverts on max attempts

### Conflict Resolution (LWW)

When server data arrives via Electric:
- **Timestamps are compared** using `_updatedAt`
- **Server wins** if server timestamp > local timestamp
- **Local wins** if local has pending changes with newer timestamp
- **Server deletes always win** - deleted items are removed regardless of local changes

### Internal Metadata Fields

The adapter uses these internal fields (automatically stripped from server payloads):

| Field | Description |
|-------|-------------|
| `_new` | `true` if item was created locally and not yet confirmed by server |
| `_deleted` | `true` if item is soft-deleted (pending server sync) |
| `_sentToServer` | `true` if change has been sent to server |
| `_modifiedColumns` | Array of field names that were changed locally |
| `_backup` | Original values before local modification (for revert) |
| `_updatedAt` | Local timestamp for LWW conflict resolution |
| `_createdAt` | Local creation timestamp |

## Utility Methods

Access via `collection.utils`:

### Database Access

```typescript
// Get direct Dexie table access
const table = notesCollection.utils.getTable()
await table.where("completed").equals(true).toArray()
```

### Manual Operations

```typescript
// Force refresh
notesCollection.utils.refresh()
await notesCollection.utils.refetch()

// Direct local writes (bypass TanStack DB)
await notesCollection.utils.insertLocally(item, fromServer?)
await notesCollection.utils.updateLocally(id, changes, fromServer?)
await notesCollection.utils.deleteLocally(id, fromServer?)
```

### Local Write Utilities

For server-originated data (e.g., WebSocket updates), use `fromServer: true`:

```typescript
// Server sends real-time update
socket.on("note:updated", async (data) => {
  await notesCollection.utils.updateLocally(data.id, data, true)
})
```

This marks the data as synced and won't trigger the write path to sync it back.

## Electric SQL Integration

### Setup

1. Set up Electric SQL on your server
2. Provide the `shapeUrl` in your collection config
3. The adapter automatically subscribes to changes

```typescript
const notesCollection = createCollection(
  dexieCollectionOptions({
    id: "notes",
    schema: noteSchema,
    getKey: (item) => item.id,
    shapeUrl: "http://localhost:3001/api/notes", // Electric endpoint
  })
)
```

### What Gets Synced

- **Inserts** - New items from server appear locally
- **Updates** - Changed fields are merged with LWW
- **Deletes** - Items are soft-deleted locally

### Online/Offline Handling

- **Going offline** - Electric subscription pauses
- **Coming online** - Subscription resumes, pending changes sync

## Examples

### Basic CRUD

```typescript
// Insert
const tx = notesCollection.insert({
  id: crypto.randomUUID(),
  content: "Hello, world!",
  createdAt: new Date(),
  updatedAt: new Date(),
})
await tx.isPersisted.promise

// Update
notesCollection.update(noteId, (note) => ({
  ...note,
  content: "Updated content",
  updatedAt: new Date(),
}))

// Delete
notesCollection.delete(noteId)
```

### With React

```typescript
import { useCollection } from "@tanstack/react-db"

function Notes() {
  const { data: notes } = useCollection(notesCollection)

  return (
    <ul>
      {notes.map((note) => (
        <li key={note.id}>{note.content}</li>
      ))}
    </ul>
  )
}
```

### Custom Retry Behavior

```typescript
const notesCollection = createCollection(
  dexieCollectionOptions({
    id: "notes",
    schema: noteSchema,
    getKey: (item) => item.id,
    
    // Retry config
    syncRetryMaxAttempts: 5,      // Give up after 5 attempts
    syncRetryBaseDelayMs: 2000,   // Start with 2s delay
    
    onInsert: async (item) => {
      const res = await fetch("/api/notes", {
        method: "POST",
        body: JSON.stringify(item),
      })
      if (!res.ok) throw new Error("Failed to insert")
    },
  })
)
```

### Data Transformation

```typescript
const notesCollection = createCollection(
  dexieCollectionOptions({
    id: "notes",
    schema: noteSchema,
    getKey: (item) => item.id,
    codec: {
      // Parse from IndexedDB format
      parse: (stored) => ({
        ...stored,
        createdAt: new Date(stored.createdAt),
        updatedAt: new Date(stored.updatedAt),
      }),
      // Serialize to IndexedDB format
      serialize: (item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      }),
    },
  })
)
```

## Testing

The package includes comprehensive tests. Run with:

```bash
npm test
```

## License

MIT
