import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// --- Constants ---
const NUM_BOXES = 1_000_000;
const BOXES_PER_DOCUMENT = 4000;
const NUM_DOCUMENTS = Math.floor(NUM_BOXES / BOXES_PER_DOCUMENT); // 250
const BYTES_PER_DOCUMENT = BOXES_PER_DOCUMENT / 8; // 500

// --- Bit manipulation helpers ---

function emptyBoxes(): number[] {
  return new Array(BYTES_PER_DOCUMENT).fill(0);
}

function isBitChecked(boxes: number[], arrayIdx: number): boolean {
  const bit = arrayIdx % 8;
  const byteIdx = Math.floor(arrayIdx / 8);
  return !!((1 << bit) & (boxes[byteIdx] || 0));
}

/** Toggle a bit. Returns true if the bit was actually changed. Mutates the array in place. */
function setBit(boxes: number[], arrayIdx: number, checked: boolean): boolean {
  if (isBitChecked(boxes, arrayIdx) === checked) return false;
  const bit = arrayIdx % 8;
  const byteIdx = Math.floor(arrayIdx / 8);
  boxes[byteIdx] = (1 << bit) ^ boxes[byteIdx];
  return true;
}

/** Deterministic pseudo-random number generator using timestamp as seed. */
function pseudoRandom(seed: number, i: number): number {
  let h = (seed + i * 374761393) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return h >>> 0;
}

// --- Tables ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PoisonJob = table({
  name: 'poison_job',
  scheduled: (): any => run_poison,
}, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
});

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

export const toggle = spacetimedb.reducer(
  { documentIdx: t.u32(), arrayIdx: t.u32(), checked: t.bool() },
  (ctx, { documentIdx, arrayIdx, checked }) => {
    if (documentIdx >= NUM_DOCUMENTS || arrayIdx >= BOXES_PER_DOCUMENT) {
      throw new Error('Index out of range');
    }
    const row = ctx.db.checkboxes.idx.find(documentIdx);
    if (!row) return;

    const boxes = [...row.boxes];
    if (setBit(boxes, arrayIdx, checked)) {
      ctx.db.checkboxes.idx.update({ ...row, boxes });
    }
  }
);

export const seed = spacetimedb.reducer((ctx) => {
  for (const row of ctx.db.checkboxes.iter()) {
    ctx.db.checkboxes.idx.delete(row.idx);
  }
  const empty = emptyBoxes();
  for (let i = 0; i < NUM_DOCUMENTS; i++) {
    ctx.db.checkboxes.insert({ idx: i, boxes: [...empty] });
  }
});

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

    // Re-schedule for 10 seconds later
    const futureTime = ctx.timestamp.microsSinceUnixEpoch + 10_000_000n;
    ctx.db.poisonJob.insert({
      scheduledId: 0n,
      scheduledAt: ScheduleAt.time(futureTime),
    });
  }
);

// --- Lifecycle ---

export const init = spacetimedb.init((ctx) => {
  // Seed the database with empty checkbox documents
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
