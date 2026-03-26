# One Billion Checkboxes

A real-time collaborative app with **one billion checkboxes** and a **multiplayer Game of Life**, built with [SpacetimeDB](https://spacetimedb.com/?referral=gillkyle) and [Solid 2.0 (beta)](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/README.md).

**Live at [one-billion-checkboxes-spacetime.vercel.app](https://one-billion-checkboxes-spacetime.vercel.app/)**

Forked from [one-million-checkboxes-spacetime](https://github.com/gillkyle/one-million-checkboxes-spacetime) by [Kyle Gill](https://github.com/gillkyle), which was inspired by the original [One Million Checkboxes](https://onemillioncheckboxes.com/) by Nolen Royalty. This fork scales it to 1 billion checkboxes, adds 15 colors, a multiplayer Game of Life, and the performance architecture described below.


## Why This Exists

This started with a tweet from [Delaney Gillilan](https://x.com/DelaneyGillilan) (CEO of [Datastar](https://data-star.dev/)) challenging the fullstack TypeScript approach:

> Sure, let's see a billion checkbox demo with either of these and compare real flame graphs and code complexity. Most of the time stuff like this is trying to paper over TS being a poor choice for a backend language, let alone full stack.

And then:

> great, make it 1000x bigger and 16 colors plz!

Challenge accepted. This project exists to prove that TypeScript *can* be a great fullstack language — when paired with the right tools.

An exploration of two technologies:

- **SolidJS 2.0** — Fine-grained reactivity without a virtual DOM. Can it handle a billion cells with constant memory and per-cell updates?
- **SpacetimeDB** — A database that pushes changes to clients via subscriptions. Can it efficiently serve real-time collaborative state at this scale?

The answer to both is yes, with some careful architecture.

```
┌──────────────────────────────┐         ┌──────────────────────────────┐
│   SolidJS 2.0 Frontend       │ ←────── │   SpacetimeDB Module         │
│                              │  subs   │                              │
│  Scaled virtual scroll (30M) │ ──────→ │  250K rows × 2KB each        │
│  Fine-grained cell reactivity│ reducer │  Nibble-packed (4 bits/cell) │
│  Two-phase subscriptions     │  calls  │  Change events (~24B each)   │
│  Optimistic UI + rate limit  │         │  Scheduled jobs (stats, GOL) │
└──────────────────────────────┘         └──────────────────────────────┘
```

```
spacetimedb/src/index.ts   — Entire backend: tables, reducers, GOL simulation
src/main.tsx               — Connection setup, routing, fingerprint registration
src/App.tsx                — 1B checkbox grid with virtual scrolling
src/GameOfLife.tsx          — 50×50 multiplayer Conway's Game of Life
src/module_bindings/        — Generated SpacetimeDB client SDK (do not edit)
scripts/                    — Benchmarking and data migration tools
```


## Data Design

Each checkbox holds a value 0–15 (unchecked + 15 colors), which fits in 4 bits. Two checkboxes per byte — **nibble packing**.

| Metric | Value |
|--------|-------|
| Total checkboxes | 1,000,000,000 |
| Checkboxes per row | 4,000 |
| Bytes per row | 2,000 |
| Total rows | 250,000 |
| Total storage | ~500 MB theoretical |

Rows are **lazily created** — a document only exists once someone colors a cell in it. An empty grid uses zero storage.

The 1B checkboxes form a virtual 2D grid. Each cell maps to a document via striped mapping:

```typescript
const documentIdx = globalIndex % NUM_DOCUMENTS;   // which row in DB (0–249,999)
const arrayIdx    = Math.floor(globalIndex / NUM_DOCUMENTS);  // position within row (0–3,999)
```

This means scrolling vertically hits different documents, keeping viewport-scoped subscriptions effective.


## Subscriptions and Diffs

The core performance principle: **never send full state when a diff will do.** SpacetimeDB pushes row changes to subscribed clients, so what you subscribe to determines what you pay for.

### Two-Phase Checkbox Subscriptions

Subscribing to full `checkboxes` rows means receiving 2,000 bytes every time any cell in that row changes. The solution is a two-phase approach.

**Phase 1 — Bootstrap.** Subscribe to `checkboxes` rows covering the visible range. This delivers baseline state for every cell in those documents:

```sql
SELECT * FROM checkboxes WHERE idx >= 100 AND idx <= 200;
```

**Phase 2 — Live updates.** Once Phase 1 arrives, immediately switch to the `checkbox_changes` table — a separate event log where each row is ~24 bytes (document index, array index, color, timestamp):

```sql
SELECT * FROM checkbox_changes WHERE document_idx >= 100 AND document_idx <= 200;
```

Phase 1 is unsubscribed. **That's ~83x less data per update** (24 bytes vs 2,000). Change events are pruned server-side after 10 seconds (scheduled job every 5s) to keep the table bounded.

Why not skip Phase 1? You need the baseline. A new client needs full state for visible documents, then can switch to deltas. Phase 1 is the catch-up, Phase 2 is the stream.

### Viewport Scoping

Only documents covering the visible area (plus a 2x buffer) are subscribed. Resubscription is **debounced** (200ms) on scroll so fast scrolling doesn't thrash subscriptions.

### How Diffs Flow Through the Client

When a change event arrives, it's applied as a single nibble mutation:

```typescript
conn.db.checkboxChanges.onInsert((_ctx, change) => {
  const { documentIdx, arrayIdx, color } = change;
  setColorLocal(rawBoxes[documentIdx], arrayIdx, color);              // mutate nibble in place
  setBoxesStore(s => { s[documentIdx] = new Uint8Array(existing); }); // trigger reactivity
});
```

The store update pushes a fresh `Uint8Array` copy — just enough to trigger Solid's reactivity. And because of fine-grained tracking, only the single cell matching that `arrayIdx` touches the DOM (not all 4,000 cells sharing that document).

### Stats Subscription

The `stats` table (one row, always subscribed) holds `totalColored`. It's recalculated every 15 seconds by a scheduled reducer that scans all documents — not on every toggle, which would make it a hot row bottleneck. Between scans, the client tracks a local `pendingCountDelta` and resets it when the server stat arrives.

### Summary

| Layer | Full state | Diff | Reduction |
|-------|-----------|------|-----------|
| Checkboxes (server -> client) | 2,000 B/row | 24 B/event | ~83x |
| GOL (server -> client) | 1,250 B/snapshot | diff log + sync per tick | snapshot avoided on hot path |
| Stats (server -> client) | Scan every 15s | Client-side delta | Avoids hot row |
| DOM (client) | Re-render all cells | Solid updates 1 node | O(1) per change |


## Solid 2.0 Showcase Architecture

This repo is intentionally leaning into **Solid 2.0's native async model**, not just using Solid as a fast renderer.

### Async reads as streams

Instead of keeping all subscription choreography inline inside components, the app now wraps staged SpacetimeDB sync flows as **domain async streams**:

- `src/lib/checkbox-stream.ts` — visible-range checkbox bootstrap -> live diff handoff
- `src/lib/gol-stream.ts` — Game of Life snapshot -> versioned diff -> resync flow
- `src/lib/streams.ts` — small async queue/stream helpers used by both

Components consume those streams and let Solid 2.0 handle the UI phases:

- **`<Loading>`** handles initial readiness
- **`isPending(...)`** reflects background resubscribe / revalidation work
- **split effects** keep side effects separate from tracked computation

This is the Solid 2.0 idea in practice: realtime subscriptions are treated as async computations, not as a pile of ad hoc callback setup.

### Async writes as actions + optimistic state

The checkbox interaction path also now uses Solid 2.0's newer mutation primitives:

- `action(...)` wraps the async reducer call
- `createOptimistic(...)` holds the temporary optimistic count delta
- `createOptimisticStore(...)` holds the temporary per-cell overlay state

Server subscriptions remain the source of truth. The optimistic layer only fills the gap between click and authoritative diff arrival.

### Projection-style client state folding

SpacetimeDB sends row snapshots and tiny diff events; the client folds those into UI state in a dedicated helper:

- `src/lib/checkbox-state.ts`

That helper owns the logic for:

- applying full row snapshots
- applying nibble-level diff events
- clearing optimistic overlays when authoritative updates arrive
- resolving per-cell round-trip timing
- reconciling server stats with optimistic local counts

This keeps `src/App.tsx` focused on Solid reactivity, viewport math, and rendering instead of low-level event bookkeeping.


## DOM Reuse and Solid 2.0 Reactivity

1 billion checkboxes at 22px each would be a 484km tall page — far beyond any browser's maximum scrollable height (~33M pixels in Chrome). Instead, a **fixed pool** of ~300 DOM elements covers the viewport + 3 rows of overscan.

The virtual spacer's height is capped at 30M pixels, with a **scroll scale factor** mapping physical scroll position to logical row position proportionally. This lets the scrollbar smoothly address all ~12.5M rows despite the browser limit. A URL-synced **offset input** (`#n`) provides pixel-perfect navigation to any of the 1 billion cells — type a number, press Enter, and the grid jumps directly there.

### `<For keyed={false}>` — Index-Based DOM Reuse

The grid uses nested `<For keyed={false}>` loops — Solid 2.0's index-based mode (replacement for the old `<Index>` component). Instead of matching DOM nodes to items by identity, **nodes are matched by position**. The element at position 0 stays at position 0 regardless of which data it represents.

In this mode, children receive **accessors** (functions), not values. `localRow()` and `col()` are reactive getters that return the current item at that position:

```typescript
<For each={rowPool()} keyed={false}>
  {(localRow) => {                              // accessor, not a value
    const rowIdx = () => startRow() + localRow();
    return (
      <For each={colPool()} keyed={false}>
        {(col) => {                             // accessor, not a value
          const globalIndex = () => rowIdx() * numColumns() + col();
          const documentIdx = () => globalIndex() % NUM_DOCUMENTS;
          const arrayIdx    = () => Math.floor(globalIndex() / NUM_DOCUMENTS);
          const colorVal    = () => getCellColor(documentIdx(), arrayIdx());
          // the <div> is created once and never recreated
        }}
      </For>
    );
  }}
</For>
```

Each `<div>` is created **once** when the pool first renders. When the user scrolls, `startRow()` updates, which recomputes every cell's `globalIndex` → `documentIdx` → `arrayIdx` → `colorVal` chain. But the DOM elements are never destroyed or recreated — Solid updates only the specific attributes and text that actually changed.

**Why `keyed={false}`?** Default `<For>` is keyed by identity — it tracks which item maps to which DOM node, moving nodes if items reorder. That's useful for sortable lists but counterproductive here. Pool items are abstract slot indices `[0, 1, 2, ...]` with nothing meaningful to key on. With `keyed={false}`, Solid skips identity tracking entirely. On resize, elements are added/removed at the end; existing ones update in-place via accessors. No diffing, no reconciliation, no teardown/rebuild.

This is the key difference from React-style virtualization, where scrolling unmounts and remounts row components (or at minimum re-renders the list). In Solid 2.0 with `keyed={false}`, the DOM pool is truly static — scrolling across millions of rows is just signal updates and targeted mutations on the same ~300 elements.

### Fine-Grained Per-Cell Updates

When a change event arrives and updates one nibble in `boxesStore[documentIdx]`, only the cell currently displaying that exact document + array index re-evaluates. A single `checkboxes` document holds 4,000 cells, but a change event only affects one — and only that one cell touches the DOM.

For the Game of Life at 10 fps, this means each `[x, y, color]` triple from a diff packet triggers exactly one DOM mutation. A tick with 50 changes = 50 targeted updates, not 2,500.

### Optimistic Updates

Toggle -> update optimistic overlays immediately -> run a Solid 2.0 `action(...)` -> let the SpacetimeDB change event reconcile the final state. Round-trip time is tracked per-cell and displayed in the UI.


## Rate Limiting and Fingerprinting

### Browser Fingerprinting

On every connection, the client loads [FingerprintJS](https://fingerprintjs.com/) and registers the visitor ID:

```typescript
FingerprintJS.load().then(fp => fp.get()).then(result => {
  conn.reducers.registerFingerprint({ fingerprint: result.visitorId });
});
```

The server stores the mapping in a private `identityFingerprint` table. This links SpacetimeDB identities to physical browsers — even across multiple tabs or token clears.

### Two-Layer Server Rate Limit

Every `toggle` call enforces a **sliding window** (1 second, 20 max) on two tables:

- **Per-identity** (`rateLimit`, keyed by `ctx.sender`) — one session
- **Per-fingerprint** (`fingerprintRateLimit`, keyed by fingerprint) — all sessions sharing a browser, catches multi-tab and VPN abuse

Both layers checked on every toggle. Exceeding either throws an error; the client catches it and shows a "Rate Limited" badge.

### Client-Side Mirror

The client independently enforces the same 20/sec limit, dropping excess clicks before they hit the WebSocket:

```typescript
if (++rateLimitCount > RATE_LIMIT_MAX) {
  setRateLimited(true);  // show badge, drop the click
  return;
}
```

If a reducer call does make it through but the server rejects it (e.g., another tab exhausted the fingerprint quota), the `.catch()` handler shows the same badge.


## Game of Life

The `/life` route hosts a 50×50 multiplayer Conway's Game of Life.

- **Tap to seed**: Stamps a cross-shaped (+) pattern plus a couple of random nearby sprouts in your color
- **Color inheritance**: Born cells inherit color from a random living neighbor (seeded PRNG)
- **Versioned handoff**: Bootstrap from `gol_bootstrap`, then replay `gol_diff_log`

### Zero-Allocation Tick Loop

The simulation runs at 10 fps. All buffers are pre-allocated at module scope to avoid GC pressure:

```typescript
const _golCurrentBuf = new Uint8Array(2500);   // current generation
const _golNextBuf    = new Uint8Array(2500);   // next generation
const _golDiffBuf    = new Uint8Array(7500);   // worst-case diff (3 bytes × 2500 cells)
```

Each tick: compute next generation → build cell-level diff into `_golDiffBuf` → append one `gol_diff_log` row → update the authoritative snapshot rows (`gol_grid`, `gol_bootstrap`) → copy next into current. Taps also increment the board version, so client sync correctness does not depend on generation changes alone.

The diff encoding is packed `[x, y, color]` triples — 3 bytes per changed cell. A typical tick costs ~150 bytes vs. 1,250 for a full snapshot (~8x reduction). The client unpacks and applies each triple as a single SolidJS store write:

```typescript
for (let i = 0; i + 2 < diff.data.length; i += 3) {
  const idx = diff.data[i + 1] * GOL_COLS + diff.data[i];
  if (cells[idx] !== diff.data[i + 2]) setCells(idx, diff.data[i + 2]);
}
```

### Bootstrap, Diffs, and Versioning

The GOL client uses a staged sync path:

1. Subscribe to `gol_bootstrap` and wait for the full atomic snapshot to land in the local cache.
2. Subscribe to `gol_diff_log WHERE version > snapshot.version` plus `gol_sync`.
3. Re-read `gol_bootstrap` inside phase 2 `onApplied`, render that as the authoritative first frame, then replay pending diffs in strict version order.

`gol_sync` stores both `generation` and `version`:

- `generation` increments every simulation tick
- `version` increments on every visible board change, including user taps between generations

That distinction matters because a tap changes the board immediately without advancing the simulation. Using `version` lets the client detect gaps or stale handoffs and re-bootstrap if needed.

The older `gol_diff` and `gol_diff_v2` tables are still written for compatibility/debugging, but the current client uses `gol_bootstrap` + `gol_diff_log`.

### Resync and Recovery

- The client treats version gaps as fatal and resubscribes from snapshot.
- A periodic full resync runs every 20 seconds as a safety net.
- `gol_bootstrap.cells` is validated client-side before use; malformed snapshots trigger resync.
- The server hydrates new snapshot tables from existing state after publish so republishing does not zero the visible board.

This matters because a cell can change during bootstrap and then become static. If the client misses the one diff that created it, that cell can stay wrong forever. The append-only `gol_diff_log` plus strict version replay avoids that class of bug.

### Checkbox handoff

Checkboxes use the same two-phase idea in a range-scoped form:

1. Subscribe to `checkboxes` for the visible document range plus `checkbox_sync`.
2. Read `checkbox_sync.latest_change_id` from the cache in `onApplied`.
3. Switch to `checkbox_changes` with `id > latest_change_id` for that range.

This prevents old retained `checkbox_changes` rows from being replayed onto already-current checkbox documents during range changes or refreshes.


## Stack

- **Backend**: [SpacetimeDB](https://spacetimedb.com/?referral=gillkyle) (TypeScript module, v2.0)
- **Frontend**: [Solid 2.0 beta](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/README.md) + Vite
- **Hosting**: [Vercel](https://vercel.com) (frontend), SpacetimeDB maincloud (backend)

## Development

```bash
npm install
npm run dev
```

### Publishing the SpacetimeDB module

```bash
spacetime publish <db-name> -p ./spacetimedb
spacetime generate --lang typescript --out-dir src/module_bindings -p ./spacetimedb
```

### Benchmarking

```bash
SPACETIMEDB_TOKEN="<token>" npx tsx scripts/bench-tps.ts
```

## License

ISC
