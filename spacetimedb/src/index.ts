/**
 * SpacetimeDB server module — defines the database schema and all server-side logic.
 *
 * Architecture:
 *   1,000,000,000 checkboxes are stored lazily across up to 250,000 rows in the
 *   `checkboxes` table. Each row holds 4,000 checkboxes packed as nibbles (4 bits
 *   each) in a 2,000-byte array. Nibble value 0 = unchecked; 1-15 = color index.
 *   Document rows are created on first use (lazy initialization), so initial
 *   startup is instant regardless of the total checkbox count.
 *
 *   A scheduled "sync_stats" job runs every 15 seconds to recalculate the global
 *   colored-checkbox count from ground truth (full scan of all document rows).
 */
import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt, Identity } from 'spacetimedb';

// --- Constants ---
const OWNER = Identity.fromString('c20036cec45c9902116128ccc5adaed19dd340abfd61c1be811d513710d75b54');
const NUM_BOXES = 1_000_000_000;
const BOXES_PER_DOCUMENT = 4000;
const NUM_DOCUMENTS = Math.floor(NUM_BOXES / BOXES_PER_DOCUMENT); // 250,000
const BYTES_PER_DOCUMENT = BOXES_PER_DOCUMENT / 2; // 2000 (4 bits per box, 2 nibbles per byte)

// --- Change event constants ---
const PRUNE_AGE_US = 10_000_000n;       // prune change events older than 10 seconds
const PRUNE_INTERVAL_US = 5_000_000n;   // run prune job every 5 seconds

// --- Game of Life constants ---
const GOL_COLS = 50;
const GOL_ROWS = 50;
const GOL_CELL_COUNT = GOL_COLS * GOL_ROWS; // 2500
const GOL_CHUNK_BYTES = GOL_COLS / 2;       // 25 bytes per row (nibble-packed)
const GOL_TICK_INTERVAL_US = 100_000n;        // 100ms — 10 fps when board is active
const GOL_TICK_INTERVAL_IDLE_US = 2_000_000n; // 2s — board is stable, slow down


// --- Game of Life pre-allocated buffers (reused every tick; no per-tick allocation) ---
const _golCurrentBuf = new Uint8Array(GOL_CELL_COUNT);
const _golNextBuf    = new Uint8Array(GOL_CELL_COUNT);
const _golNbuf       = new Uint8Array(8);
// Diff buffer: worst case 2500 cells change × 3 bytes each = 7500 bytes.
const _golDiffBuf    = new Uint8Array(GOL_CELL_COUNT * 3);
// Whether _golCurrentBuf has been populated from DB (needed after republish).
let _golBufferHydrated = false;

// --- Loop detection ---
// Rolling hash history to detect oscillating patterns (period 1–64).
const GOL_LOOP_HISTORY_SIZE = 64;
const _golHashHistory = new Uint32Array(GOL_LOOP_HISTORY_SIZE);
let _golHashCount = 0;
// Packed alive/dead bits for hashing: ceil(2500/8) = 313 bytes.
const _golBitsBuf = new Uint8Array(Math.ceil(GOL_CELL_COUNT / 8));

/** FNV-1a 32-bit hash of the alive/dead bit pattern (ignoring colors). */
function golStateHash(cells: Uint8Array): number {
  _golBitsBuf.fill(0);
  for (let i = 0; i < GOL_CELL_COUNT; i++) {
    if (cells[i]) _golBitsBuf[i >> 3] |= (1 << (i & 7));
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < _golBitsBuf.length; i++) {
    h ^= _golBitsBuf[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Check if hash matches any in history. Returns period (distance back) or 0. */
function golCheckLoop(hash: number): number {
  const count = Math.min(_golHashCount, GOL_LOOP_HISTORY_SIZE);
  for (let i = 1; i <= count; i++) {
    const idx = ((_golHashCount - i) % GOL_LOOP_HISTORY_SIZE + GOL_LOOP_HISTORY_SIZE) % GOL_LOOP_HISTORY_SIZE;
    if (_golHashHistory[idx] === hash) return i;
  }
  return 0;
}

function golRecordHash(hash: number): void {
  _golHashHistory[_golHashCount % GOL_LOOP_HISTORY_SIZE] = hash;
  _golHashCount++;
}

function golClearLoopHistory(): void {
  _golHashCount = 0;
}

// --- Nibble manipulation helpers ---

/** Returns a zero-filled byte array representing 4,000 unchecked/uncolored boxes. */
function emptyBoxes(): Uint8Array {
  return new Uint8Array(BYTES_PER_DOCUMENT);
}

/**
 * Reads the 4-bit nibble color value for checkbox `arrayIdx` from the byte array.
 * Returns 0 (unchecked) through 15 (color index).
 */
function getColor(boxes: ArrayLike<number>, arrayIdx: number): number {
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  return arrayIdx % 2 === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
}

/**
 * Sets the 4-bit nibble for checkbox `arrayIdx` to `color` (0-15).
 * Mutates in place. Returns true if the value actually changed.
 */
function setColor(boxes: number[] | Uint8Array, arrayIdx: number, color: number): boolean {
  const current = getColor(boxes, arrayIdx);
  if (current === color) return false;
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  boxes[byteIdx] = arrayIdx % 2 === 0
    ? (byte & 0xF0) | (color & 0x0F)
    : (byte & 0x0F) | ((color & 0x0F) << 4);
  return true;
}

/** Count all non-zero nibbles in a boxes byte array. */
function countColored(boxes: ArrayLike<number>): number {
  let count = 0;
  for (let i = 0; i < boxes.length; i++) {
    const byte = boxes[i];
    if (byte === 0) continue;
    if (byte & 0x0F) count++;
    if (byte >> 4) count++;
  }
  return count;
}

// --- Tables ---

/**
 * Scheduled table for the periodic stats sync job.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SyncStatsJob = table({
  name: 'sync_stats_job',
  scheduled: (): any => run_sync_stats,
}, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PruneChangesJob = table({
  name: 'prune_changes_job',
  scheduled: (): any => run_prune_changes,
}, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const GolTickJob = table({
  name: 'gol_tick_job',
  scheduled: (): any => run_gol_tick,
}, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

// GOL grid: one row per GOL row (50 rows × 25 bytes nibble-packed).
// Used for initial client state on subscribe and periodic snapshots (every
// GOL_SNAPSHOT_INTERVAL ticks). Live per-tick updates go through gol_diff.
const GolRowChunk = table(
  { name: 'gol_row_chunk', public: true },
  {
    rowIdx: t.u32().primaryKey(), // 0–49: which GOL row
    cells:  t.byteArray(),        // 25 bytes, nibble-packed (50 cells × 4 bits)
  }
);

// Single-row metadata: generation counter, updated every tick.
const GolMeta = table(
  { name: 'gol_meta', public: true },
  {
    id:         t.u32().primaryKey(),
    generation: t.u64(),
  }
);

// Single-row loop detection status (separate table to avoid migration).
const GolLoopStatus = table(
  { name: 'gol_loop_status', public: true },
  {
    id:         t.u32().primaryKey(),
    loopPeriod: t.u32(), // 0 = not looping, N = detected oscillator period
  }
);

// Per-tick diff: single row containing packed cell changes [x, y, color, ...].
// Clients subscribe to this instead of gol_row_chunk for live updates — one
// WebSocket message per tick instead of up to 50 row-chunk updates.
const GolDiff = table(
  { name: 'gol_diff', public: true },
  {
    id:   t.u32().primaryKey(),
    data: t.byteArray(), // packed triples: [x, y, color, x, y, color, ...]
  }
);

const spacetimedb = schema({
  checkboxes: table(
    { name: 'checkboxes', public: true },
    {
      idx: t.u32().primaryKey(),
      boxes: t.byteArray(),
    }
  ),
  checkboxChanges: table(
    {
      name: 'checkbox_changes',
      public: true,
      indexes: [
        { name: 'checkbox_changes_document_idx', algorithm: 'btree', columns: ['documentIdx'] },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      documentIdx: t.u32(),
      arrayIdx: t.u32(),
      color: t.u32(),
      createdAt: t.u64(), // microseconds since epoch — used by pruner
    }
  ),
  stats: table(
    { name: 'stats', public: true },
    {
      id: t.u32().primaryKey(),
      totalColored: t.u64(),
    }
  ),
  rateLimit: table(
    { name: 'rate_limit' },
    {
      identity: t.identity().primaryKey(),
      lastToggleAt: t.u64(), // microseconds since epoch
      toggleCount: t.u32(),  // toggles in current window
    }
  ),
  identityFingerprint: table(
    { name: 'identity_fingerprint' },
    {
      identity: t.identity().primaryKey(),
      fingerprint: t.string(),
    }
  ),
  fingerprintRateLimit: table(
    { name: 'fingerprint_rate_limit' },
    {
      fingerprint: t.string().primaryKey(),
      lastToggleAt: t.u64(),
      toggleCount: t.u32(),
    }
  ),
  syncStatsJob: SyncStatsJob,
  pruneChangesJob: PruneChangesJob,
  // Kept for migration compatibility — SpacetimeDB doesn't allow removing tables.
  // No longer read or written; superseded by golRowChunk + golMeta.
  golGrid: table(
    { name: 'gol_grid', public: true },
    {
      id: t.u32().primaryKey(),
      cells: t.byteArray(),
      generation: t.u64(),
    }
  ),
  golRowChunk: GolRowChunk,
  golMeta: GolMeta,
  golDiff: GolDiff,
  golLoopStatus: GolLoopStatus,
  golTickJob: GolTickJob,
});
export default spacetimedb;

// --- Helpers ---


const RATE_LIMIT_WINDOW_US = 1_000_000n; // 1 second in microseconds
const RATE_LIMIT_MAX_TOGGLES = 20;      // max toggles per window

/** Enforce a sliding-window rate limit on a single table. Returns true if allowed. */
function enforceWindowLimit(
  table: any,
  key: any,
  now: bigint,
  findFn: () => any,
  insertFn: () => void,
): void {
  const existing = findFn();
  if (existing) {
    const elapsed = now - existing.lastToggleAt;
    if (elapsed < RATE_LIMIT_WINDOW_US) {
      if (existing.toggleCount >= RATE_LIMIT_MAX_TOGGLES) {
        throw new Error('Rate limit exceeded — slow down');
      }
      table.update({ ...existing, toggleCount: existing.toggleCount + 1 });
    } else {
      table.update({ ...existing, lastToggleAt: now, toggleCount: 1 });
    }
  } else {
    insertFn();
  }
}

/** Check and enforce rate limit. Throws if client is too fast. */
function checkRateLimit(ctx: any) {
  const now = ctx.timestamp.microsSinceUnixEpoch;

  // Layer 1: Per-identity rate limit
  enforceWindowLimit(
    ctx.db.rateLimit.identity, ctx.sender, now,
    () => ctx.db.rateLimit.identity.find(ctx.sender),
    () => ctx.db.rateLimit.insert({ identity: ctx.sender, lastToggleAt: now, toggleCount: 1 }),
  );

  // Layer 2: Per-fingerprint rate limit (shared across all identities with same fingerprint)
  const fpMapping = ctx.db.identityFingerprint.identity.find(ctx.sender);
  if (fpMapping) {
    const fp = fpMapping.fingerprint;
    enforceWindowLimit(
      ctx.db.fingerprintRateLimit.fingerprint, fp, now,
      () => ctx.db.fingerprintRateLimit.fingerprint.find(fp),
      () => ctx.db.fingerprintRateLimit.insert({ fingerprint: fp, lastToggleAt: now, toggleCount: 1 }),
    );
  }
}

/** Recalculate totalColored by scanning all checkboxes rows. */
function recalcStats(ctx: any) {
  let total = 0;
  let docCount = 0;
  for (const row of ctx.db.checkboxes.iter()) {
    total += countColored(row.boxes);
    docCount++;
  }
  const existing = ctx.db.stats.id.find(0);
  if (existing) {
    ctx.db.stats.id.update({ ...existing, totalColored: BigInt(total) });
  } else {
    ctx.db.stats.insert({ id: 0, totalColored: BigInt(total) });
  }
}

// --- Reducers ---

/** Register a browser fingerprint for the calling identity. Called once per session. */
export const register_fingerprint = spacetimedb.reducer(
  { fingerprint: t.string() },
  (ctx, { fingerprint }) => {
    if (!/^[a-f0-9]{32}$/.test(fingerprint)) {
      throw new SenderError('Invalid fingerprint format');
    }
    const existing = ctx.db.identityFingerprint.identity.find(ctx.sender);
    if (existing) {
      ctx.db.identityFingerprint.identity.update({ ...existing, fingerprint });
    } else {
      ctx.db.identityFingerprint.insert({ identity: ctx.sender, fingerprint });
    }
  }
);

/**
 * Set the color of a single checkbox. Called from the client on click.
 * color: 0 = uncheck, 1-15 = color index.
 * Creates the document row lazily on first use.
 */
export const toggle = spacetimedb.reducer(
  { documentIdx: t.u32(), arrayIdx: t.u32(), color: t.u32() },
  (ctx, { documentIdx, arrayIdx, color }) => {
    checkRateLimit(ctx);

    if (documentIdx >= NUM_DOCUMENTS || arrayIdx >= BOXES_PER_DOCUMENT) {
      throw new Error('Index out of range');
    }
    const clampedColor = Math.min(color, 15);

    let changed = false;
    const existing = ctx.db.checkboxes.idx.find(documentIdx);
    if (existing) {
      const boxes = new Uint8Array(existing.boxes);
      if (setColor(boxes, arrayIdx, clampedColor)) {
        ctx.db.checkboxes.idx.update({ ...existing, boxes });
        changed = true;
      }
    } else if (clampedColor > 0) {
      const boxes = emptyBoxes();
      setColor(boxes, arrayIdx, clampedColor);
      ctx.db.checkboxes.insert({ idx: documentIdx, boxes });
      changed = true;
    }

    // Emit a lightweight change event (~24 bytes vs 2KB full row)
    if (changed) {
      ctx.db.checkboxChanges.insert({
        id: 0n,
        documentIdx,
        arrayIdx,
        color: clampedColor,
        createdAt: ctx.timestamp.microsSinceUnixEpoch,
      });
    }
  }
);

/** Bulk import a document row. Owner only — used for data migration. */
export const import_boxes = spacetimedb.reducer(
  { idx: t.u32(), boxes: t.byteArray() },
  (ctx, { idx, boxes }) => {
    if (!ctx.sender.isEqual(OWNER)) throw new SenderError('Unauthorized');
    if (idx >= NUM_DOCUMENTS) throw new SenderError('Index out of range');
    if (boxes.length !== BYTES_PER_DOCUMENT) throw new SenderError('Invalid boxes length');

    const existing = ctx.db.checkboxes.idx.find(idx);
    if (existing) {
      ctx.db.checkboxes.idx.update({ ...existing, boxes });
    } else {
      ctx.db.checkboxes.insert({ idx, boxes });
    }
  }
);

/** Reset all checkboxes to unchecked by deleting all document rows. Owner only. */
export const seed = spacetimedb.reducer((ctx) => {
  if (!ctx.sender.isEqual(OWNER)) throw new SenderError('Unauthorized');
  for (const row of ctx.db.checkboxes.iter()) {
    ctx.db.checkboxes.idx.delete(row.idx);
  }
  const stats = ctx.db.stats.id.find(0);
  if (stats) {
    ctx.db.stats.id.update({ ...stats, totalColored: 0n });
  }
});

/** Scheduled reducer: recalculate stats from ground truth, then reschedule. */
export const run_sync_stats = spacetimedb.reducer(
  { arg: SyncStatsJob.rowType },
  (ctx, { arg: _arg }) => {
    recalcStats(ctx);

    // Reschedule in 5 seconds
    const futureTime = ctx.timestamp.microsSinceUnixEpoch + 15_000_000n;
    ctx.db.syncStatsJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(futureTime),
    });
  }
);

/** Scheduled reducer: prune old change events, then reschedule. */
export const run_prune_changes = spacetimedb.reducer(
  { arg: PruneChangesJob.rowType },
  (ctx, { arg: _arg }) => {
    // Only delete events older than PRUNE_AGE_US — recent events may still
    // be needed by clients in Phase 1→2 transition.
    const cutoff = ctx.timestamp.microsSinceUnixEpoch - PRUNE_AGE_US;
    const toDelete: bigint[] = [];
    for (const row of ctx.db.checkboxChanges.iter()) {
      if (row.createdAt < cutoff) {
        toDelete.push(row.id);
      }
    }
    for (const id of toDelete) {
      ctx.db.checkboxChanges.id.delete(id);
    }

    // Reschedule
    ctx.db.pruneChangesJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + PRUNE_INTERVAL_US),
    });
  }
);

/** Manual trigger to recalculate stats. Owner only. */
export const sync_stats = spacetimedb.reducer((ctx) => {
  if (!ctx.sender.isEqual(OWNER)) throw new SenderError('Unauthorized');
  recalcStats(ctx);
});

// --- Game of Life helpers ---

/**
 * Simple 32-bit xorshift PRNG. Mutates state in-place via the returned object.
 * Deterministic for a given seed, but varying the seed (e.g. from timestamp)
 * produces nondeterministic payload evolution across ticks — same board state
 * at different times yields different inheritance outcomes.
 */
function createRng(seed: number) {
  let s = (seed | 0) || 1; // must be non-zero
  return {
    /** Returns a non-negative 32-bit integer. */
    next(): number {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return s >>> 0;
    },
  };
}

/**
 * Pure next-generation function for Conway's Game of Life with rich payloads.
 *
 * Cell values: 0 = dead, 1-15 = alive with color/lineage payload.
 * Conway rules (classic): survive on 2-3 neighbors, birth on exactly 3, death otherwise.
 * Non-wrapping edges: neighbors outside the grid are ignored (boundary-safe).
 *
 * Non-classic extension — payload inheritance:
 *   On birth, the new cell inherits the payload of one living neighbor chosen
 *   via a seeded PRNG. Surviving cells keep their current payload. This means:
 *     - stable structures preserve local identity
 *     - births inherit from the surrounding population
 *     - mixed populations diffuse visually across the board
 *     - repeated runs from the same structural state may differ in payload
 *       distribution while life/death structure remains identical
 *
 * Performance: writes into the module-level _golNextBuf (no allocation per tick).
 * The returned reference points at _golNextBuf — caller must use it before the
 * next invocation. Safe in SpacetimeDB's single-threaded reducer model.
 *
 * @param cells  Current grid (length GOL_CELL_COUNT, values 0-15) — use _golCurrentBuf
 * @param seed   PRNG seed — vary per tick (e.g. from ctx.timestamp) for nondeterminism
 */
function golNextGeneration(cells: Uint8Array, seed: number): Uint8Array {
  _golNextBuf.fill(0);
  const rng = createRng(seed);

  for (let y = 0; y < GOL_ROWS; y++) {
    for (let x = 0; x < GOL_COLS; x++) {
      // Collect living neighbor payloads (boundary-safe, no wrapping)
      let ncount = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= GOL_COLS || ny < 0 || ny >= GOL_ROWS) continue;
          const val = cells[ny * GOL_COLS + nx];
          if (val) _golNbuf[ncount++] = val;
        }
      }

      const idx = y * GOL_COLS + x;
      const currentVal = cells[idx];

      if (currentVal !== 0 && (ncount === 2 || ncount === 3)) {
        // Survival: preserve current payload
        _golNextBuf[idx] = currentVal;
      } else if (currentVal === 0 && ncount === 3) {
        // Birth: inherit payload from a random living neighbor
        _golNextBuf[idx] = _golNbuf[rng.next() % ncount];
      }
      // else: death — stays 0
    }
  }
  return _golNextBuf;
}

/**
 * Ensure GOL grid is initialised.  Uses golMeta existence as a sentinel —
 * if meta row 0 exists, all 50 row-chunks are assumed to exist too.
 */
function ensureGolGrid(ctx: any): void {
  if (ctx.db.golMeta.id.find(0)) return; // already initialised
  ctx.db.golMeta.insert({ id: 0, generation: 0n });
  ctx.db.golLoopStatus.insert({ id: 0, loopPeriod: 0 });
  ctx.db.golDiff.insert({ id: 0, data: new Uint8Array(0) });
  for (let rowIdx = 0; rowIdx < GOL_ROWS; rowIdx++) {
    ctx.db.golRowChunk.insert({ rowIdx, cells: new Uint8Array(GOL_CHUNK_BYTES) });
  }
}

// --- Game of Life reducers ---

/**
 * Derive a stable color (1-15) from a player's identity.
 * Different users get different colors; same user always gets the same color.
 */
function colorFromIdentity(identity: any): number {
  const hex = identity.toHexString() as string;
  let hash = 0;
  for (let i = 0; i < hex.length; i++) {
    hash = ((hash << 5) - hash + hex.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 15) + 1; // 1-15
}

/**
 * Tap a cell: stamp a cross-shaped seed pattern (+) centered on (x, y).
 * The color is derived from the caller's identity — multiplayer users
 * get distinct colors automatically. Boundary-safe: arms that would
 * extend off the grid are clipped rather than wrapping.
 *
 * Updates only the affected row chunks (1–3 rows for a cross pattern).
 */
export const gol_tap_cell = spacetimedb.reducer(
  { x: t.u32(), y: t.u32() },
  (ctx, { x, y }) => {
    checkRateLimit(ctx);
    if (x >= GOL_COLS || y >= GOL_ROWS) throw new SenderError('Out of bounds');
    ensureGolGrid(ctx);
    golClearLoopHistory(); // new input breaks any detected loop

    // Immediately clear the loop status so clients hide the "loop" indicator
    const loopRow = ctx.db.golLoopStatus.id.find(0);
    if (loopRow && loopRow.loopPeriod !== 0) {
      ctx.db.golLoopStatus.id.update({ id: 0, loopPeriod: 0 });
    }

    // Cancel the slow idle tick and reschedule at full speed
    for (const job of ctx.db.golTickJob.iter()) {
      ctx.db.golTickJob.scheduledId.delete(job.scheduledId);
    }
    ctx.db.golTickJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + GOL_TICK_INTERVAL_US),
    });

    const color = colorFromIdentity(ctx.sender);

    // Center + four arms (boundary-safe: skip out-of-bounds).
    // Group by row so we read/write each chunk at most once.
    const points: [number, number][] = [
      [x, y], [x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y],
    ];
    const byRow = new Map<number, number[]>(); // rowIdx → [colIdx, ...]
    for (const [px, py] of points) {
      if (px >= 0 && px < GOL_COLS && py >= 0 && py < GOL_ROWS) {
        let cols = byRow.get(py);
        if (!cols) { cols = []; byRow.set(py, cols); }
        cols.push(px);
      }
    }
    for (const [rowIdx, cols] of byRow) {
      const existing = ctx.db.golRowChunk.rowIdx.find(rowIdx);
      const cells = existing ? new Uint8Array(existing.cells) : new Uint8Array(GOL_CHUNK_BYTES);
      for (const col of cols) {
        setColor(cells, col, color);
        // Keep in-memory buffer in sync so the next tick sees the tap.
        _golCurrentBuf[rowIdx * GOL_COLS + col] = color;
      }
      if (existing) {
        ctx.db.golRowChunk.rowIdx.update({ rowIdx, cells });
      } else {
        ctx.db.golRowChunk.insert({ rowIdx, cells });
      }
    }
  }
);

/**
 * Scheduled reducer: advance one GOL generation and always reschedule.
 *
 * Bandwidth strategy:
 *   - Every tick: write a single gol_diff row with packed cell-level changes
 *     [x, y, color, ...]. One WebSocket message per tick regardless of how
 *     many cells changed.
 *   - Every GOL_SNAPSHOT_INTERVAL ticks: sync gol_row_chunk so new clients
 *     joining mid-game get a recent snapshot.
 *   - Adaptive tick rate: 50ms active, 2s idle.
 */
export const run_gol_tick = spacetimedb.reducer(
  { arg: GolTickJob.rowType },
  (ctx, { arg: _arg }) => {
    ensureGolGrid(ctx);

    // 1. Hydrate from DB on first tick after (re)publish; thereafter use in-memory state.
    if (!_golBufferHydrated) {
      _golCurrentBuf.fill(0);
      for (const chunk of ctx.db.golRowChunk.iter()) {
        const base = chunk.rowIdx * GOL_COLS;
        for (let x = 0; x < GOL_COLS; x++) {
          _golCurrentBuf[base + x] = getColor(chunk.cells, x);
        }
      }
      _golBufferHydrated = true;
    }

    // 2. Compute next generation (writes into _golNextBuf).
    const seed = Number(ctx.timestamp.microsSinceUnixEpoch & 0xFFFFFFFFn);
    golNextGeneration(_golCurrentBuf, seed);

    // 3. Build cell-level diff and track which rows changed.
    let diffLen = 0;
    const dirtyRows = new Set<number>();
    for (let i = 0; i < GOL_CELL_COUNT; i++) {
      if (_golNextBuf[i] !== _golCurrentBuf[i]) {
        _golDiffBuf[diffLen++] = i % GOL_COLS;              // x
        _golDiffBuf[diffLen++] = (i / GOL_COLS) | 0;        // y
        _golDiffBuf[diffLen++] = _golNextBuf[i];             // color
        dirtyRows.add((i / GOL_COLS) | 0);
      }
    }

    // 4. Loop detection: hash the alive/dead pattern and check history.
    const stateHash = golStateHash(_golNextBuf);
    const loopPeriod = golCheckLoop(stateHash);
    golRecordHash(stateHash);

    // 5. Advance in-memory state: current ← next for the next tick.
    _golCurrentBuf.set(_golNextBuf);

    // 6. Write diff row (single broadcast per tick). Skip when idle to avoid
    //    broadcasting an empty byte array every 2s.
    if (diffLen > 0) {
      const diffRow = ctx.db.golDiff.id.find(0);
      const diffSlice = _golDiffBuf.slice(0, diffLen);
      if (diffRow) {
        ctx.db.golDiff.id.update({ id: 0, data: diffSlice });
      } else {
        ctx.db.golDiff.insert({ id: 0, data: diffSlice });
      }
    }

    // 7. Update generation counter.
    const meta = ctx.db.golMeta.id.find(0)!;
    const gen = meta.generation + 1n;
    ctx.db.golMeta.id.update({ ...meta, generation: gen });

    // 7b. Update loop detection status (only surface loops with period > 2;
    //     period 1 = static and period 2 = blinkers are normal GOL behavior).
    const reportedPeriod = loopPeriod > 2 ? loopPeriod : 0;
    const loopRow = ctx.db.golLoopStatus.id.find(0);
    if (loopRow) {
      if (loopRow.loopPeriod !== reportedPeriod) {
        ctx.db.golLoopStatus.id.update({ id: 0, loopPeriod: reportedPeriod });
      }
    } else {
      ctx.db.golLoopStatus.insert({ id: 0, loopPeriod: reportedPeriod });
    }

    // 8. Update only the changed row chunks every tick (self-contained;
    //    clients don't need sequential diff accumulation to stay in sync).
    for (const rowIdx of dirtyRows) {
      const base = rowIdx * GOL_COLS;
      const newCells = new Uint8Array(GOL_CHUNK_BYTES);
      for (let x = 0; x < GOL_COLS; x++) setColor(newCells, x, _golCurrentBuf[base + x]);
      const existing = ctx.db.golRowChunk.rowIdx.find(rowIdx);
      if (existing) {
        ctx.db.golRowChunk.rowIdx.update({ rowIdx, cells: newCells });
      } else {
        ctx.db.golRowChunk.insert({ rowIdx, cells: newCells });
      }
    }

    // 9. Adaptive reschedule: slow down only for higher-order loops (period > 2).
    //    Period 1 (static) and 2 (blinkers etc.) are normal GOL behavior.
    const isIdle = diffLen === 0 || loopPeriod > 2;
    const interval = isIdle ? GOL_TICK_INTERVAL_IDLE_US : GOL_TICK_INTERVAL_US;
    ctx.db.golTickJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + interval),
    });
  }
);

// --- Lifecycle ---

export const init = spacetimedb.init((ctx) => {
  // Sync stats from existing data
  recalcStats(ctx);

  // Schedule stats sync job (15s interval)
  const syncTime = ctx.timestamp.microsSinceUnixEpoch + 15_000_000n;
  ctx.db.syncStatsJob.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(syncTime),
  });

  // Ensure GOL grid exists and start the always-on tick loop
  ensureGolGrid(ctx);
  ctx.db.golTickJob.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + GOL_TICK_INTERVAL_US),
  });

  // Start the change-event prune loop
  ctx.db.pruneChangesJob.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + PRUNE_INTERVAL_US),
  });
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  // Ensure GOL grid is initialised and the tick loop is running.
  // init only fires on first database creation; after a republish the tick
  // chain may be dead.  Only schedule if no pending tick jobs exist (prevents
  // parallel tick chains from stacking up).
  ensureGolGrid(ctx);
  let hasTickJob = false;
  for (const _ of ctx.db.golTickJob.iter()) {
    hasTickJob = true;
    break;
  }
  if (!hasTickJob) {
    ctx.db.golTickJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + GOL_TICK_INTERVAL_US),
    });
  }

  // Ensure the change-event prune loop is running
  let hasPruneJob = false;
  for (const _ of ctx.db.pruneChangesJob.iter()) {
    hasPruneJob = true;
    break;
  }
  if (!hasPruneJob) {
    ctx.db.pruneChangesJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + PRUNE_INTERVAL_US),
    });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected((_ctx) => {});
