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
const GOL_GRID_BYTES = GOL_CELL_COUNT / 2;  // 1250 bytes for the full board
const GOL_TICK_INTERVAL_US = 100_000n;      // 100ms — 10 fps always
const GOL_DIFF_HISTORY_LIMIT = 4096n;

// --- Game of Life pre-allocated buffers (reused every tick; no per-tick allocation) ---
const _golCurrentBuf = new Uint8Array(GOL_CELL_COUNT);
const _golNextBuf    = new Uint8Array(GOL_CELL_COUNT);
const _golNbuf       = new Uint8Array(8);
// Diff buffer: worst case 2500 cells change × 3 bytes each = 7500 bytes.
const _golDiffBuf    = new Uint8Array(GOL_CELL_COUNT * 3);

// Whether _golCurrentBuf has been populated from DB (needed after republish).
let _golBufferHydrated = false;

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

const GolSync = table(
  { name: 'gol_sync', public: true },
  {
    id:         t.u32().primaryKey(),
    version:    t.u64(),
    generation: t.u64(),
  }
);

const GolBootstrap = table(
  { name: 'gol_bootstrap', public: true },
  {
    id:         t.u32().primaryKey(),
    cells:      t.byteArray(),
    version:    t.u64(),
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

const GolDiffV2 = table(
  { name: 'gol_diff_v2', public: true },
  {
    id:      t.u32().primaryKey(),
    version: t.u64(),
    data:    t.byteArray(),
  }
);

const GolDiffLog = table(
  { name: 'gol_diff_log', public: true },
  {
    version: t.u64().primaryKey(),
    data:    t.byteArray(),
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
  checkboxSync: table(
    { name: 'checkbox_sync', public: true },
    {
      id: t.u32().primaryKey(),
      latestChangeId: t.u64(),
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
  // Compact full-board snapshot used only during client bootstrap.
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
  golBootstrap: GolBootstrap,
  golSync: GolSync,
  golDiff: GolDiff,
  golDiffV2: GolDiffV2,
  golDiffLog: GolDiffLog,
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
      const change = ctx.db.checkboxChanges.insert({
        id: 0n,
        documentIdx,
        arrayIdx,
        color: clampedColor,
        createdAt: ctx.timestamp.microsSinceUnixEpoch,
      });

      const sync = ctx.db.checkboxSync.id.find(0);
      if (sync) {
        ctx.db.checkboxSync.id.update({ id: 0, latestChangeId: change.id });
      } else {
        ctx.db.checkboxSync.insert({ id: 0, latestChangeId: change.id });
      }
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
 * Ensure all persisted GOL state exists, hydrating from older snapshot sources
 * when newer tables are missing after a publish.
 */
function ensureGolGrid(ctx: any): void {
  const bootstrap = ctx.db.golBootstrap.id.find(0);
  const grid = ctx.db.golGrid.id.find(0);
  const existingMeta = ctx.db.golMeta.id.find(0);
  const existingSync = ctx.db.golSync.id.find(0);

  let recoveredGeneration = existingMeta?.generation ?? bootstrap?.generation ?? grid?.generation ?? 0n;
  let recoveredVersion = existingSync?.version ?? bootstrap?.version ?? 0n;

  if (!existingSync) {
    for (const row of ctx.db.golDiffLog.iter()) {
      if (row.version > recoveredVersion) recoveredVersion = row.version;
    }
  }

  if (!existingMeta) {
    ctx.db.golMeta.insert({ id: 0, generation: recoveredGeneration });
  }

  if (!existingSync) {
    ctx.db.golSync.insert({ id: 0, version: recoveredVersion, generation: recoveredGeneration });
  }

  const sync = ctx.db.golSync.id.find(0)!;

  const hasGrid = !!ctx.db.golGrid.id.find(0);
  const hasBootstrap = !!ctx.db.golBootstrap.id.find(0);
  if (!hasGrid || !hasBootstrap) {
    golHydrateBufferFromDb(ctx);
    if (!hasGrid) golSyncGrid(ctx, sync.generation);
    if (!hasBootstrap) golSyncBootstrap(ctx, sync.version, sync.generation);
  }

  if (!ctx.db.golDiff.id.find(0)) {
    ctx.db.golDiff.insert({ id: 0, data: new Uint8Array(0) });
  }
  if (!ctx.db.golDiffV2.id.find(0)) {
    ctx.db.golDiffV2.insert({ id: 0, version: 0n, data: new Uint8Array(0) });
  }
  for (let rowIdx = 0; rowIdx < GOL_ROWS; rowIdx++) {
    if (!ctx.db.golRowChunk.rowIdx.find(rowIdx)) {
      ctx.db.golRowChunk.insert({ rowIdx, cells: new Uint8Array(GOL_CHUNK_BYTES) });
    }
  }
}

function ensureCheckboxSync(ctx: any) {
  if (ctx.db.checkboxSync.id.find(0)) return;

  let latestChangeId = 0n;
  for (const row of ctx.db.checkboxChanges.iter()) {
    if (row.id > latestChangeId) latestChangeId = row.id;
  }

  ctx.db.checkboxSync.insert({ id: 0, latestChangeId });
}

function golUpsertSync(ctx: any, version: bigint, generation: bigint): void {
  const row = ctx.db.golSync.id.find(0);
  if (row) {
    ctx.db.golSync.id.update({ id: 0, version, generation });
  } else {
    ctx.db.golSync.insert({ id: 0, version, generation });
  }
}

function golWriteDiffRows(ctx: any, version: bigint, data: Uint8Array): void {
  const diffRow = ctx.db.golDiff.id.find(0);
  if (diffRow) {
    ctx.db.golDiff.id.update({ id: 0, data });
  } else {
    ctx.db.golDiff.insert({ id: 0, data });
  }

  const diffV2Row = ctx.db.golDiffV2.id.find(0);
  if (diffV2Row) {
    ctx.db.golDiffV2.id.update({ id: 0, version, data });
  } else {
    ctx.db.golDiffV2.insert({ id: 0, version, data });
  }

  ctx.db.golDiffLog.insert({ version, data });
  if (version > GOL_DIFF_HISTORY_LIMIT) {
    ctx.db.golDiffLog.version.delete(version - GOL_DIFF_HISTORY_LIMIT);
  }
}

function golSyncRows(ctx: any, rowMask: Uint8Array): void {
  for (let rowIdx = 0; rowIdx < GOL_ROWS; rowIdx++) {
    if (rowMask[rowIdx] === 0) continue;
    const base = rowIdx * GOL_COLS;
    const cells = new Uint8Array(GOL_CHUNK_BYTES);
    for (let x = 0; x < GOL_COLS; x++) setColor(cells, x, _golCurrentBuf[base + x]);
    const existing = ctx.db.golRowChunk.rowIdx.find(rowIdx);
    if (existing) {
      ctx.db.golRowChunk.rowIdx.update({ rowIdx, cells });
    } else {
      ctx.db.golRowChunk.insert({ rowIdx, cells });
    }
  }
}

function golSyncGrid(ctx: any, generation: bigint): void {
  const cells = new Uint8Array(GOL_GRID_BYTES);
  for (let idx = 0; idx < GOL_CELL_COUNT; idx++) {
    setColor(cells, idx, _golCurrentBuf[idx]);
  }

  const existing = ctx.db.golGrid.id.find(0);
  if (existing) {
    ctx.db.golGrid.id.update({ id: 0, cells, generation });
  } else {
    ctx.db.golGrid.insert({ id: 0, cells, generation });
  }
}

function golSyncBootstrap(ctx: any, version: bigint, generation: bigint): void {
  const cells = new Uint8Array(GOL_GRID_BYTES);
  for (let idx = 0; idx < GOL_CELL_COUNT; idx++) {
    setColor(cells, idx, _golCurrentBuf[idx]);
  }

  const existing = ctx.db.golBootstrap.id.find(0);
  if (existing) {
    ctx.db.golBootstrap.id.update({ id: 0, cells, version, generation });
  } else {
    ctx.db.golBootstrap.insert({ id: 0, cells, version, generation });
  }
}

function golHydrateBufferFromDb(ctx: any): void {
  if (_golBufferHydrated) return;

  _golCurrentBuf.fill(0);
  const grid = ctx.db.golGrid.id.find(0);
  if (grid && grid.cells.length === GOL_GRID_BYTES) {
    for (let idx = 0; idx < GOL_CELL_COUNT; idx++) {
      _golCurrentBuf[idx] = getColor(grid.cells, idx);
    }
    _golBufferHydrated = true;
    return;
  }

  const bootstrap = ctx.db.golBootstrap.id.find(0);
  if (bootstrap && bootstrap.cells.length === GOL_GRID_BYTES) {
    for (let idx = 0; idx < GOL_CELL_COUNT; idx++) {
      _golCurrentBuf[idx] = getColor(bootstrap.cells, idx);
    }
    _golBufferHydrated = true;
    return;
  }

  for (const chunk of ctx.db.golRowChunk.iter()) {
    const base = chunk.rowIdx * GOL_COLS;
    for (let x = 0; x < GOL_COLS; x++) {
      _golCurrentBuf[base + x] = getColor(chunk.cells, x);
    }
  }

  _golBufferHydrated = true;
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
 * Emits a compact diff immediately and keeps the touched row chunks current for
 * newly bootstrapping clients.
 */
export const gol_tap_cell = spacetimedb.reducer(
  { x: t.u32(), y: t.u32() },
  (ctx, { x, y }) => {
    checkRateLimit(ctx);
    if (x >= GOL_COLS || y >= GOL_ROWS) throw new SenderError('Out of bounds');
    ensureGolGrid(ctx);

    // Keep the normal tick chain running; only backfill a job if it is missing.
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

    const color = colorFromIdentity(ctx.sender);

    golHydrateBufferFromDb(ctx);

    // Center + four arms, plus a couple of small random sprouts so taps
    // feel less mechanically identical.
    const points: [number, number][] = [
      [x, y], [x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y],
    ];
    const rngSeed = Number(
      (ctx.timestamp.microsSinceUnixEpoch
        ^ (BigInt(x) << 16n)
        ^ (BigInt(y) << 1n)) & 0xFFFFFFFFn
    );
    const rng = createRng(rngSeed);
    const candidates: [number, number][] = [
      [x - 1, y - 1],
      [x, y - 2],
      [x + 1, y - 1],
      [x - 2, y],
      [x + 2, y],
      [x - 1, y + 1],
      [x, y + 2],
      [x + 1, y + 1],
    ];
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = rng.next() % (i + 1);
      const tmp = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = tmp;
    }
    points.push(candidates[0], candidates[1]);

    const seen = new Set<string>();
    let diffLen = 0;
    for (const [px, py] of points) {
      const key = `${px},${py}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (px >= 0 && px < GOL_COLS && py >= 0 && py < GOL_ROWS) {
        const idx = py * GOL_COLS + px;
        if (_golCurrentBuf[idx] === color) continue;
        _golCurrentBuf[idx] = color;
        _golDiffBuf[diffLen++] = px;
        _golDiffBuf[diffLen++] = py;
        _golDiffBuf[diffLen++] = color;
      }
    }

    if (diffLen === 0) return;

    const rowMask = new Uint8Array(GOL_ROWS);
    for (let i = 1; i < diffLen; i += 3) rowMask[_golDiffBuf[i]] = 1;

    const diffSlice = _golDiffBuf.slice(0, diffLen);
    const sync = ctx.db.golSync.id.find(0)!;
    const nextVersion = sync.version + 1n;
    golWriteDiffRows(ctx, nextVersion, diffSlice);
    golSyncRows(ctx, rowMask);
    golSyncGrid(ctx, sync.generation);
    golSyncBootstrap(ctx, nextVersion, sync.generation);
    golUpsertSync(ctx, nextVersion, sync.generation);
  }
);

/**
 * Scheduled reducer: advance one GOL generation and always reschedule.
 *
 * Bandwidth strategy:
 *   - Bootstrap clients load one atomic board snapshot from `gol_bootstrap`.
 *   - Live clients replay append-only `gol_diff_log` rows in version order.
 *   - The board runs continuously at 10 fps.
 */
export const run_gol_tick = spacetimedb.reducer(
  { arg: GolTickJob.rowType },
  (ctx, { arg: _arg }) => {
    ensureGolGrid(ctx);

    // 1. Hydrate from DB on first tick after (re)publish; thereafter use in-memory state.
    golHydrateBufferFromDb(ctx);

    // 2. Compute next generation (writes into _golNextBuf).
    const seed = Number(ctx.timestamp.microsSinceUnixEpoch & 0xFFFFFFFFn);
    golNextGeneration(_golCurrentBuf, seed);

    // 3. Build cell-level diff into pre-allocated buffer.
    let diffLen = 0;
    for (let i = 0; i < GOL_CELL_COUNT; i++) {
      if (_golNextBuf[i] !== _golCurrentBuf[i]) {
        _golDiffBuf[diffLen++] = i % GOL_COLS;              // x
        _golDiffBuf[diffLen++] = (i / GOL_COLS) | 0;        // y
        _golDiffBuf[diffLen++] = _golNextBuf[i];             // color
      }
    }

    // 4. Advance in-memory state: current <- next for the next tick.
    _golCurrentBuf.set(_golNextBuf);

    const meta = ctx.db.golMeta.id.find(0)!;
    const sync = ctx.db.golSync.id.find(0)!;
    const gen = meta.generation + 1n;
    let nextVersion = sync.version;

    // 5. Write diff row when the board actually changes.
    if (diffLen > 0) {
      const rowMask = new Uint8Array(GOL_ROWS);
      for (let i = 1; i < diffLen; i += 3) rowMask[_golDiffBuf[i]] = 1;

        const diffSlice = _golDiffBuf.slice(0, diffLen);
        nextVersion = sync.version + 1n;
        golWriteDiffRows(ctx, nextVersion, diffSlice);
        golSyncRows(ctx, rowMask);
      }

    // 6. Update generation counter and the authoritative full-board snapshot.
    ctx.db.golMeta.id.update({ ...meta, generation: gen });
    golSyncGrid(ctx, gen);
    golSyncBootstrap(ctx, nextVersion, gen);
    golUpsertSync(ctx, nextVersion, gen);

    // 7. Reschedule the next tick at a constant 10 fps.
    ctx.db.golTickJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + GOL_TICK_INTERVAL_US),
    });
  }
);

// --- Lifecycle ---

export const init = spacetimedb.init((ctx) => {
  // Sync stats from existing data
  recalcStats(ctx);
  ensureCheckboxSync(ctx);

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
  ensureCheckboxSync(ctx);

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
