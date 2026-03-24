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
 *   A scheduled "poison" reducer runs every 10 seconds to randomly toggle 10
 *   checkboxes, keeping the board alive even when no users are interacting.
 *
 *   A scheduled "sync_stats" job runs every 5 seconds to recalculate the global
 *   colored-checkbox count from ground truth (full scan of all document rows).
 */
import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// --- Constants ---
const NUM_BOXES = 1_000_000_000;
const BOXES_PER_DOCUMENT = 4000;
const NUM_DOCUMENTS = Math.floor(NUM_BOXES / BOXES_PER_DOCUMENT); // 250,000
const BYTES_PER_DOCUMENT = BOXES_PER_DOCUMENT / 2; // 2000 (4 bits per box, 2 nibbles per byte)

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

/**
 * Deterministic PRNG (reducers can't use Math.random).
 * Uses a multiplicative hash to derive a pseudo-random u32 from (seed, i).
 */
function pseudoRandom(seed: number, i: number): number {
  let h = (seed + i * 374761393) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return h >>> 0;
}

// --- Tables ---

/**
 * Scheduled table for the "poison the well" recurring job.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PoisonJob = table({
  name: 'poison_job',
  scheduled: (): any => run_poison,
}, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

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

const spacetimedb = schema({
  checkboxes: table(
    {
      name: 'checkboxes',
      public: true,
      indexes: [{ name: 'checkboxes_idx', algorithm: 'btree', columns: ['idx'] }],
    },
    {
      idx: t.u32().primaryKey(),
      boxes: t.byteArray(),
    }
  ),
  stats: table(
    {
      name: 'stats',
      public: true,
      indexes: [{ name: 'stats_id', algorithm: 'btree', columns: ['id'] }],
    },
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
  poisonJob: PoisonJob,
  syncStatsJob: SyncStatsJob,
});
export default spacetimedb;

// --- Helpers ---

/** Atomically increment or decrement totalColored by exactly 1. */
function incrementStats(ctx: any, delta: 1 | -1) {
  const row = ctx.db.stats.id.find(0);
  if (row) {
    const next = delta === 1
      ? row.totalColored + 1n
      : row.totalColored > 0n ? row.totalColored - 1n : 0n;
    ctx.db.stats.id.update({ ...row, totalColored: next });
  } else {
    ctx.db.stats.insert({ id: 0, totalColored: delta === 1 ? 1n : 0n });
  }
}

const RATE_LIMIT_WINDOW_US = 1_000_000n; // 1 second in microseconds
const RATE_LIMIT_MAX_TOGGLES = 20;      // max toggles per window

/** Check and enforce rate limit. Throws if client is too fast. */
function checkRateLimit(ctx: any) {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const existing = ctx.db.rateLimit.identity.find(ctx.sender);

  if (existing) {
    const elapsed = now - existing.lastToggleAt;
    if (elapsed < RATE_LIMIT_WINDOW_US) {
      // Still in the same window
      if (existing.toggleCount >= RATE_LIMIT_MAX_TOGGLES) {
        throw new Error('Rate limit exceeded — slow down');
      }
      ctx.db.rateLimit.identity.update({
        ...existing,
        toggleCount: existing.toggleCount + 1,
      });
    } else {
      // New window — reset counter
      ctx.db.rateLimit.identity.update({
        ...existing,
        lastToggleAt: now,
        toggleCount: 1,
      });
    }
  } else {
    ctx.db.rateLimit.insert({
      identity: ctx.sender,
      lastToggleAt: now,
      toggleCount: 1,
    });
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

    const existing = ctx.db.checkboxes.idx.find(documentIdx);
    if (existing) {
      const boxes = new Uint8Array(existing.boxes);
      const oldColor = getColor(boxes, arrayIdx);
      if (setColor(boxes, arrayIdx, clampedColor)) {
        ctx.db.checkboxes.idx.update({ ...existing, boxes });
        // Atomic ±1 stats update (only when colored state changes)
        if (oldColor === 0 && clampedColor > 0) incrementStats(ctx, 1);
        else if (oldColor > 0 && clampedColor === 0) incrementStats(ctx, -1);
      }
    } else if (clampedColor > 0) {
      const boxes = emptyBoxes();
      setColor(boxes, arrayIdx, clampedColor);
      ctx.db.checkboxes.insert({ idx: documentIdx, boxes });
      incrementStats(ctx, 1);
    }
  }
);

/** Reset all checkboxes to unchecked by deleting all document rows. */
export const seed = spacetimedb.reducer((ctx) => {
  for (const row of ctx.db.checkboxes.iter()) {
    ctx.db.checkboxes.idx.delete(row.idx);
  }
  const stats = ctx.db.stats.id.find(0);
  if (stats) {
    ctx.db.stats.id.update({ ...stats, totalColored: 0n });
  }
});

/**
 * "Poison the well" — scheduled reducer that randomly colors/uncolors 10 checkboxes
 * then re-schedules itself 10 seconds later.
 */
export const run_poison = spacetimedb.reducer(
  { arg: PoisonJob.rowType },
  (ctx, { arg: _arg }) => {
    const prngSeed = Number(ctx.timestamp.microsSinceUnixEpoch % BigInt(Number.MAX_SAFE_INTEGER));

    for (let i = 0; i < 10; i++) {
      const val = pseudoRandom(prngSeed, i);
      const documentIdx = val % NUM_DOCUMENTS;
      const arrayIdx = (val >>> 8) % BOXES_PER_DOCUMENT;
      const color = (val >>> 16) % 16;

      const row = ctx.db.checkboxes.idx.find(documentIdx);
      if (row) {
        const boxes = [...row.boxes];
        if (setColor(boxes, arrayIdx, color)) {
          ctx.db.checkboxes.idx.update({ ...row, boxes });
        }
      } else if (color > 0) {
        const boxes = emptyBoxes();
        setColor(boxes, arrayIdx, color);
        ctx.db.checkboxes.insert({ idx: documentIdx, boxes });
      }
    }

    const futureTime = ctx.timestamp.microsSinceUnixEpoch + 10_000_000n;
    ctx.db.poisonJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(futureTime),
    });
  }
);

/** Scheduled reducer: recalculate stats from ground truth, then reschedule. */
export const run_sync_stats = spacetimedb.reducer(
  { arg: SyncStatsJob.rowType },
  (ctx, { arg: _arg }) => {
    recalcStats(ctx);

    // Reschedule in 5 seconds
    const futureTime = ctx.timestamp.microsSinceUnixEpoch + 5_000_000n;
    ctx.db.syncStatsJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(futureTime),
    });
  }
);

/** Manual trigger to recalculate stats. */
export const sync_stats = spacetimedb.reducer((ctx) => {
  recalcStats(ctx);
});

// --- Lifecycle ---

export const init = spacetimedb.init((ctx) => {
  // Sync stats from existing data
  recalcStats(ctx);

  // Schedule poison job (10s interval)
  const poisonTime = ctx.timestamp.microsSinceUnixEpoch + 10_000_000n;
  ctx.db.poisonJob.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(poisonTime),
  });

  // Schedule stats sync job (5s interval)
  const syncTime = ctx.timestamp.microsSinceUnixEpoch + 5_000_000n;
  ctx.db.syncStatsJob.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(syncTime),
  });
});

export const onConnect = spacetimedb.clientConnected((_ctx) => {});

export const onDisconnect = spacetimedb.clientDisconnected((_ctx) => {});
