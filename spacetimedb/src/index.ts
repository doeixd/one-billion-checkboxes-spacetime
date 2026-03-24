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
function emptyBoxes(): number[] {
  return new Array(BYTES_PER_DOCUMENT).fill(0);
}

/**
 * Reads the 4-bit nibble color value for checkbox `arrayIdx` from the byte array.
 * Returns 0 (unchecked) through 15 (color index).
 */
function getColor(boxes: number[], arrayIdx: number): number {
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  return arrayIdx % 2 === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
}

/**
 * Sets the 4-bit nibble for checkbox `arrayIdx` to `color` (0-15).
 * Mutates in place. Returns true if the value actually changed.
 */
function setColor(boxes: number[], arrayIdx: number, color: number): boolean {
  const current = getColor(boxes, arrayIdx);
  if (current === color) return false;
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  boxes[byteIdx] = arrayIdx % 2 === 0
    ? (byte & 0xF0) | (color & 0x0F)
    : (byte & 0x0F) | ((color & 0x0F) << 4);
  return true;
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
 * The `(): any` return type annotation breaks a circular TypeScript
 * inference chain between PoisonJob ↔ run_poison ↔ spacetimedb schema.
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
 * Schema: `checkboxes` — up to 250,000 public rows, each with a u32 primary key
 * (0-249,999) and a 2,000-byte nibble-packed array holding 4,000 checkbox colors.
 */
const spacetimedb = schema({
  checkboxes: table(
    { name: 'checkboxes', public: true },
    {
      idx: t.u32().primaryKey(),
      boxes: t.array(t.u8()),
    }
  ),
  poisonJob: PoisonJob,
});
export default spacetimedb;

// --- Reducers ---

/**
 * Set the color of a single checkbox. Called from the client on click.
 * color: 0 = uncheck, 1-15 = color index.
 * Creates the document row lazily on first use.
 */
export const toggle = spacetimedb.reducer(
  { documentIdx: t.u32(), arrayIdx: t.u32(), color: t.u32() },
  (ctx, { documentIdx, arrayIdx, color }) => {
    if (documentIdx >= NUM_DOCUMENTS || arrayIdx >= BOXES_PER_DOCUMENT) {
      throw new Error('Index out of range');
    }
    const clampedColor = Math.min(color, 15);

    const existing = ctx.db.checkboxes.idx.find(documentIdx);
    if (existing) {
      const boxes = [...existing.boxes];
      if (setColor(boxes, arrayIdx, clampedColor)) {
        ctx.db.checkboxes.idx.update({ ...existing, boxes });
      }
    } else if (clampedColor > 0) {
      // Lazily create the document on first non-zero interaction
      const boxes = emptyBoxes();
      setColor(boxes, arrayIdx, clampedColor);
      ctx.db.checkboxes.insert({ idx: documentIdx, boxes });
    }
  }
);

/** Reset all checkboxes to unchecked by deleting all document rows. */
export const seed = spacetimedb.reducer((ctx) => {
  for (const row of ctx.db.checkboxes.iter()) {
    ctx.db.checkboxes.idx.delete(row.idx);
  }
});

/**
 * "Poison the well" — scheduled reducer that randomly colors/uncolors 10 checkboxes
 * then re-schedules itself 10 seconds later. Uses ctx.timestamp as a PRNG seed
 * since SpacetimeDB reducers must be fully deterministic.
 */
export const run_poison = spacetimedb.reducer(
  { arg: PoisonJob.rowType },
  (ctx, { arg: _arg }) => {
    const prngSeed = Number(ctx.timestamp.microsSinceUnixEpoch % BigInt(Number.MAX_SAFE_INTEGER));

    for (let i = 0; i < 10; i++) {
      const val = pseudoRandom(prngSeed, i);
      const documentIdx = val % NUM_DOCUMENTS;
      const arrayIdx = (val >>> 8) % BOXES_PER_DOCUMENT;
      const color = (val >>> 16) % 16; // 0 = uncheck, 1-15 = random color

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

    // Re-schedule for 10 seconds later (value is in microseconds)
    const futureTime = ctx.timestamp.microsSinceUnixEpoch + 10_000_000n;
    ctx.db.poisonJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(futureTime),
    });
  }
);

// --- Lifecycle ---

/**
 * Runs once on first publish — document rows are created lazily on first use,
 * so we only need to schedule the first poison job here.
 */
export const init = spacetimedb.init((ctx) => {
  const futureTime = ctx.timestamp.microsSinceUnixEpoch + 10_000_000n;
  ctx.db.poisonJob.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(futureTime),
  });
});

export const onConnect = spacetimedb.clientConnected((_ctx) => {
  console.log('Client connected');
});

export const onDisconnect = spacetimedb.clientDisconnected((_ctx) => {
  console.log('Client disconnected');
});
