/**
 * Export all colored checkboxes from the current DB as (globalIndex, color) pairs.
 * Outputs a JSON file that can be used to re-seed after a schema migration.
 *
 * Usage: npx tsx scripts/export-checkboxes.ts
 */
import { DbConnection } from '../src/module_bindings/index.ts';
import type { Checkboxes } from '../src/module_bindings/types.ts';
import fs from 'fs';

const HOST = process.env.SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? 'deni-x4u44';
const OUT_FILE = process.env.OUT_FILE ?? 'scripts/checkboxes-export.json';

const NUM_DOCUMENTS = 250_000;

function getColor(boxes: ArrayLike<number>, arrayIdx: number): number {
  const byte = boxes[Math.floor(arrayIdx / 2)] || 0;
  return arrayIdx % 2 === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
}

console.log(`Connecting to ${HOST} / ${DB_NAME}...`);

const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withConfirmedReads(false)
  .onConnect(() => {
    console.log('Connected. Subscribing to all checkboxes...');
    conn.subscriptionBuilder()
      .onApplied(() => {
        console.log('Subscription applied. Extracting colored checkboxes...');

        const colored: Array<{ g: number; c: number }> = [];

        for (const row of conn.db.checkboxes.iter()) {
          const boxes = row.boxes;
          const boxesPerDoc = boxes.length * 2; // 2 nibbles per byte
          for (let arrayIdx = 0; arrayIdx < boxesPerDoc; arrayIdx++) {
            const color = getColor(boxes, arrayIdx);
            if (color > 0) {
              // Reconstruct global index from old layout
              const globalIndex = row.idx + NUM_DOCUMENTS * arrayIdx;
              colored.push({ g: globalIndex, c: color });
            }
          }
        }

        console.log(`Found ${colored.length} colored checkboxes.`);
        fs.writeFileSync(OUT_FILE, JSON.stringify(colored));
        console.log(`Saved to ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
        process.exit(0);
      })
      .onError((e) => {
        console.error('Subscription error:', e);
        process.exit(1);
      })
      .subscribe(['SELECT * FROM checkboxes']);
  })
  .onConnectError((_ctx, err) => {
    console.error('Connection error:', err);
    process.exit(1);
  })
  .build();
