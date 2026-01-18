# TanStack Dexie Electric Collection

> ⚠️ **Experimental** - This is an exploratory project, not a production-ready library. Use at your own risk.

An experimental fork exploring offline-first patterns with TanStack DB, Dexie.js, and Electric SQL real-time sync.

## What I Learned

Building this was a rabbit hole. I started thinking "how hard can offline-first be?" and ended up mass 1500 line adapter with metadata fields I didn't know I'd need.

**The hard parts nobody warns you about:**

- **Sync state is messy.** You need to track: is this new? is it deleted? did we send it? what changed? what was the original value? That's why there are all those `_underscore` fields.

- **Conflicts are inevitable.** Two users edit the same note offline. Who wins? I went with Last Write Wins (timestamps) because it's simple. CRDTs would be better but my brain couldn't handle it at 2am.

- **The write path needs to be separate.** At first I tried calling `onInsert` directly when the user clicks save. Bad idea. Now there's a watcher (`liveQuery`) that detects unsynced rows and handles it async. Much cleaner.

- **Retry logic is essential.** Networks fail. Servers timeout. You need exponential backoff and a way to revert changes when you've tried enough times.

- **`fromServer` matters.** When Electric sends an update, you don't want to sync it back to the server. Sounds obvious but I broke this twice.

- **Stripping internal fields is easy to forget.** Sent `_backup` and `_modifiedColumns` to my Prisma endpoint. Got very confused error messages.

If you're building something similar, I hope this saves you some headaches. Or at least shows you're not alone in finding this stuff tricky.

## Credits

This project is based on [HimanshuKumarDutt094/tanstack-dexie-db-collection](https://github.com/HimanshuKumarDutt094/tanstack-dexie-db-collection). I extended it to explore:

- Electric SQL ShapeStream integration for real-time server sync
- Automatic write path that syncs local changes to a server
- Conflict resolution with Last Write Wins (LWW)
- Retry logic with exponential backoff
- Online/offline handling

## Installation

**There is no npm package.** Clone or copy the source directly:

```bash
git clone https://github.com/Batuhan1999/tanstack-dexie-electric-collection.git
```

Then copy the `src/` folder into your project or set up a local package.

### Dependencies

You'll need these peer dependencies:

```bash
npm install @tanstack/react-db dexie @electric-sql/client zod
```

## Basic Example

```typescript
import { createCollection } from "@tanstack/react-db"
import { dexieElectricSyncOptions } from "./path-to-src"
import { z } from "zod"

const noteSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export const notesCollection = createCollection(
  dexieElectricSyncOptions({
    id: "notes",
    schema: noteSchema,
    getKey: (item) => item.id,
    
    // Optional: Electric SQL endpoint for real-time sync
    shapeUrl: "http://localhost:3001/api/notes",
    
    // Server sync handlers (called automatically by write path)
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

## How It Works

### Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   TanStack DB   │────▶│   Dexie.js      │────▶│   IndexedDB     │
│   (In-Memory)   │◀────│   (Adapter)     │◀────│   (Storage)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               │ Write Path Watcher
                               │ (liveQuery detects unsynced rows)
                               ▼
                        ┌─────────────────┐
                        │  Your Server    │
                        │  (onInsert/     │
                        │   onUpdate/     │
                        │   onDelete)     │
                        └─────────────────┘
                               │
                               │ Electric ShapeStream
                               │ (real-time updates)
                               ▼
                        ┌─────────────────┐
                        │  Electric SQL   │
                        └─────────────────┘
```

### Data Flow

**Local changes:**
1. User makes change via TanStack DB
2. Change written to IndexedDB immediately
3. Write path watcher detects unsynced row
4. Calls your `onInsert`/`onUpdate`/`onDelete` handler
5. On success: marks as synced
6. On failure: retries with exponential backoff, reverts after max attempts

**Server changes (via Electric):**
1. Electric ShapeStream receives server update
2. Conflict resolution compares timestamps (LWW)
3. If server wins: local data updated
4. If local has newer pending changes: local wins

### Internal Metadata

The adapter tracks sync state with internal fields (stripped before sending to server):

```typescript
{
  _new: boolean,           // Created locally, not confirmed by server
  _deleted: boolean,       // Soft-deleted, pending server sync
  _sentToServer: boolean,  // Change has been sent
  _modifiedColumns: string[], // Which fields changed
  _backup: object,         // Original values for revert
  _updatedAt: number,      // Timestamp for LWW
  _createdAt: number,      // Creation timestamp
}
```

## Configuration

### Required

| Option | Type | Description |
|--------|------|-------------|
| `getKey` | `(item) => string \| number` | Extract unique key from item |

### Database

| Option | Default | Description |
|--------|---------|-------------|
| `id` | - | Collection/table identifier |
| `dbName` | `'app-db'` | Dexie database name |
| `tableName` | `id` | Dexie table name |
| `schema` | - | Zod schema for validation |

### Electric Sync (Optional)

| Option | Description |
|--------|-------------|
| `shapeUrl` | Electric ShapeStream URL |

### Server Handlers

| Option | Signature | Description |
|--------|-----------|-------------|
| `onInsert` | `(item) => Promise<any>` | Sync new item to server |
| `onUpdate` | `(id, changes, modifiedColumns) => Promise<any>` | Sync update to server |
| `onDelete` | `(id) => Promise<any>` | Sync delete to server |

### Retry Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `syncRetryMaxAttempts` | `10` | Max retries before revert |
| `syncRetryBaseDelayMs` | `1000` | Base delay (doubles each retry) |

## Utility Methods

```typescript
// Direct table access
const table = collection.utils.getTable()

// Force refresh
collection.utils.refresh()
await collection.utils.refetch()

// Direct local writes (for server-originated data)
await collection.utils.insertLocally(item, fromServer?)
await collection.utils.updateLocally(id, changes, fromServer?)
await collection.utils.deleteLocally(id, fromServer?)
```

### Server-Originated Data

When receiving data from WebSocket or other real-time sources (not Electric), use `fromServer: true`:

```typescript
socket.on("note:updated", async (data) => {
  // Won't trigger write path to sync back
  await collection.utils.updateLocally(data.id, data, true)
})
```

## Example: React Component

```typescript
import { useCollection } from "@tanstack/react-db"

function Notes() {
  const { data: notes } = useCollection(notesCollection)

  const addNote = () => {
    notesCollection.insert({
      id: crypto.randomUUID(),
      content: "New note",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    // Automatically persisted to IndexedDB
    // Automatically synced to server via onInsert
  }

  return (
    <div>
      <button onClick={addNote}>Add Note</button>
      <ul>
        {notes.map((note) => (
          <li key={note.id}>{note.content}</li>
        ))}
      </ul>
    </div>
  )
}
```

## Known Limitations

- **Experimental** - APIs may change
- **No npm package** - Manual installation required
- **Electric SQL specific** - Real-time sync assumes Electric ShapeStream
- **LWW only** - No support for CRDTs or custom merge strategies
- **Browser only** - Not tested in Node.js/SSR environments

## Running Tests

```bash
npm install
npm test
```

## License

MIT

---

*This is a personal exploration project. Feedback and contributions welcome, but no guarantees of maintenance or support.*
