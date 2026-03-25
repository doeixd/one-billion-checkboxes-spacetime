/**
 * Benchmark: measure toggle transactions per second by painting a checkerboard
 * pattern starting around global index 100,000 × 250,000 = row ~100K.
 *
 * Usage: SPACETIMEDB_TOKEN="<token>" npx tsx scripts/bench-tps.ts
 */

// Polyfill for Node < 22
if (typeof Promise.withResolvers === 'undefined') {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

import { DbConnection } from '../src/module_bindings/index.ts';

const HOST = process.env.SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? 'deni-x4u44';
const TOKEN = process.env.SPACETIMEDB_TOKEN;
if (!TOKEN) {
  console.error('Set SPACETIMEDB_TOKEN to your auth token.');
  process.exit(1);
}

const NUM_DOCUMENTS = 250_000;
const COLS = 50; // assumed grid width for checkerboard
const START_ROW = 100_000;
const NUM_ROWS = 200; // 200 rows × 50 cols = 10,000 toggles
const TOTAL = NUM_ROWS * COLS;
const CONCURRENCY = 20; // in-flight reducer calls

// Pre-compute all toggle calls (checkerboard: color if (row+col) is even)
const calls: Array<{ documentIdx: number; arrayIdx: number; color: number }> = [];
for (let r = 0; r < NUM_ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const isCheckerboard = (r + c) % 2 === 0;
    if (!isCheckerboard) continue;
    const globalIndex = (START_ROW + r) * COLS + c;
    const documentIdx = globalIndex % NUM_DOCUMENTS;
    const arrayIdx = Math.floor(globalIndex / NUM_DOCUMENTS);
    const color = (r % 15) + 1; // cycle colors 1-15
    calls.push({ documentIdx, arrayIdx, color });
  }
}

console.log(`Checkerboard: ${calls.length} toggles starting at row ${START_ROW}`);
console.log(`Concurrency: ${CONCURRENCY} in-flight calls`);
console.log(`Connecting...`);

const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(TOKEN)
  .withConfirmedReads(false)
  .onConnect(async () => {
    console.log('Connected. Starting benchmark...\n');

    let completed = 0;
    let errors = 0;
    let idx = 0;
    const startTime = performance.now();
    let lastReport = startTime;

    const next = async (): Promise<void> => {
      while (idx < calls.length) {
        const call = calls[idx++];
        try {
          await conn.reducers.toggle(call);
          completed++;
        } catch {
          errors++;
        }

        const now = performance.now();
        if (now - lastReport >= 2000) {
          const elapsed = (now - startTime) / 1000;
          const tps = completed / elapsed;
          console.log(`  ${completed}/${calls.length} done — ${tps.toFixed(1)} TPS (${errors} errors)`);
          lastReport = now;
        }
      }
    };

    // Launch concurrent workers
    const workers = Array.from({ length: CONCURRENCY }, () => next());
    await Promise.all(workers);

    const elapsed = (performance.now() - startTime) / 1000;
    const tps = completed / elapsed;

    console.log(`\n=== Results ===`);
    console.log(`Toggles:    ${completed}`);
    console.log(`Errors:     ${errors}`);
    console.log(`Time:       ${elapsed.toFixed(2)}s`);
    console.log(`Throughput: ${tps.toFixed(1)} TPS`);

    process.exit(0);
  })
  .onConnectError((_ctx, err) => {
    console.error('Connection error:', err);
    process.exit(1);
  })
  .build();
