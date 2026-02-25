/**
 * SpacetimeDB server module — defines the database schema and all server-side logic.
 *
 * Architecture:
 *   1,000,000 checkboxes are stored across 250 rows in the `checkboxes` table.
 *   Each row holds 4,000 checkboxes packed into a 500-byte array (1 bit per checkbox).
 *   This keeps total storage at ~125 KB and means a single toggle only updates one row.
 *
 *   A scheduled "poison" reducer runs every 10 seconds to randomly toggle 10
 *   checkboxes, keeping the board alive even when no users are interacting.
 */
import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// --- Constants ---
const NUM_BOXES = 1_000_000;
const BOXES_PER_DOCUMENT = 4000;
const NUM_DOCUMENTS = Math.floor(NUM_BOXES / BOXES_PER_DOCUMENT); // 250
const BYTES_PER_DOCUMENT = BOXES_PER_DOCUMENT / 8; // 500

// --- Bit manipulation helpers ---

/** Returns a zero-filled byte array representing 4,000 unchecked boxes. */
function emptyBoxes(): number[] {
  return new Array(BYTES_PER_DOCUMENT).fill(0);
}

/** Reads bit `arrayIdx` from a byte array. */
function isBitChecked(boxes: number[], arrayIdx: number): boolean {
  const bit = arrayIdx % 8;
  const byteIdx = Math.floor(arrayIdx / 8);
  return !!((1 << bit) & (boxes[byteIdx] || 0));
}

/**
 * Sets or clears bit `arrayIdx` in the byte array (mutates in place).
 * Returns true if the bit actually changed — this avoids unnecessary
 * database writes when the checkbox is already in the desired state.
 */
function setBit(boxes: number[], arrayIdx: number, checked: boolean): boolean {
  if (isBitChecked(boxes, arrayIdx) === checked) return false;
  const bit = arrayIdx % 8;
  const byteIdx = Math.floor(arrayIdx / 8);
  boxes[byteIdx] = (1 << bit) ^ boxes[byteIdx];
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
 * SpacetimeDB auto-deletes each row after its reducer fires, so the
 * reducer re-inserts a new row to keep the cycle going.
 *
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
 * Schema: defines all tables and exports the `spacetimedb` handle used
 * to create reducers and lifecycle hooks below.
 *
 * `checkboxes` — 250 public rows, each with a u32 primary key (0-249) and
 * a byte array holding the bit-packed checkbox states.
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

/** Toggle a single checkbox. Called from the client on click. */
export const toggle = spacetimedb.reducer(
  { documentIdx: t.u32(), arrayIdx: t.u32(), checked: t.bool() },
  (ctx, { documentIdx, arrayIdx, checked }) => {
    if (documentIdx >= NUM_DOCUMENTS || arrayIdx >= BOXES_PER_DOCUMENT) {
      throw new Error('Index out of range');
    }
    const row = ctx.db.checkboxes.idx.find(documentIdx);
    if (!row) return;

    // Copy the byte array so we can mutate it, then write back if changed
    const boxes = [...row.boxes];
    if (setBit(boxes, arrayIdx, checked)) {
      ctx.db.checkboxes.idx.update({ ...row, boxes });
    }
  }
);

/** Reset all checkboxes to unchecked. Can be called manually to wipe the board. */
export const seed = spacetimedb.reducer((ctx) => {
  for (const row of ctx.db.checkboxes.iter()) {
    ctx.db.checkboxes.idx.delete(row.idx);
  }
  const empty = emptyBoxes();
  for (let i = 0; i < NUM_DOCUMENTS; i++) {
    ctx.db.checkboxes.insert({ idx: i, boxes: [...empty] });
  }
});

/**
 * "Poison the well" — scheduled reducer that toggles 10 random checkboxes
 * then re-schedules itself 10 seconds later. Uses ctx.timestamp as a PRNG
 * seed since SpacetimeDB reducers must be fully deterministic.
 */
export const run_poison = spacetimedb.reducer(
  { arg: PoisonJob.rowType },
  (ctx, { arg: _arg }) => {
    const prngSeed = Number(ctx.timestamp.microsSinceUnixEpoch % BigInt(Number.MAX_SAFE_INTEGER));

    for (let i = 0; i < 10; i++) {
      const val = pseudoRandom(prngSeed, i);
      const documentIdx = val % NUM_DOCUMENTS;
      const arrayIdx = (val >>> 8) % BOXES_PER_DOCUMENT;

      const row = ctx.db.checkboxes.idx.find(documentIdx);
      if (row) {
        const boxes = [...row.boxes];
        const currentlyChecked = isBitChecked(boxes, arrayIdx);
        if (setBit(boxes, arrayIdx, !currentlyChecked)) {
          ctx.db.checkboxes.idx.update({ ...row, boxes });
        }
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

/** Runs once on first publish — seeds 250 empty documents and starts the poison loop. */
export const init = spacetimedb.init((ctx) => {
  const empty = emptyBoxes();
  for (let i = 0; i < NUM_DOCUMENTS; i++) {
    ctx.db.checkboxes.insert({ idx: i, boxes: [...empty] });
  }

  // Schedule the first poison job (10 seconds from now)
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
