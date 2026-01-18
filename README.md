# TanStack Dexie Electric Collection

> ⚠️ **Experimental** - This is a learning project, not a production-ready library. Use at your own risk.

An experimental fork exploring offline-first patterns with TanStack DB, Dexie.js, and Electric SQL real-time sync.

## Why I Built This

I was learning Electric SQL and came across [this TanStack DB issue about persistence](https://github.com/TanStack/db/issues/865). The discussion laid out all the hard problems: sync state, multi-tab conflicts, schema evolution, larger-than-memory data. I was keen on trying it out especially because before that i saw the indexdb tanstack integration which this is based upon. And i wanted to combine them". This led me into deep rabbit hole about conflict resolution, lampert, hlc clocks. 



## Credits

This project is based on [HimanshuKumarDutt094/tanstack-dexie-db-collection](https://github.com/HimanshuKumarDutt094/tanstack-dexie-db-collection). I extended it to explore:

- Fully offline first by using write through caching
- Electric SQL ShapeStream integration for real-time server sync
- Automatic write path that syncs local changes to a server
- Conflict resolution with Last Write Wins (LWW)
- Retry logic with exponential backoff
- Online/offline handling


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




