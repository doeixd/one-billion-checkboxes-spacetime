/**
 * Import colored checkboxes from an export JSON file into the new DB schema.
 * Remaps global indices to the new document layout and calls import_boxes reducer.
 *
 * Usage: npx tsx scripts/import-checkboxes.ts
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
import fs from 'fs';

const HOST = process.env.SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? 'deni-x4u44';
const IN_FILE = process.env.IN_FILE ?? 'scripts/checkboxes-export.json';
const TOKEN = process.env.SPACETIMEDB_TOKEN;
if (!TOKEN) {
  console.error('Set SPACETIMEDB_TOKEN to the owner identity auth token (from browser localStorage).');
  process.exit(1);
}

// New layout constants (must match server after Phase 2)
const NEW_BOXES_PER_DOC = 4000;
const NEW_NUM_DOCUMENTS = 250_000;
const NEW_BYTES_PER_DOC = NEW_BOXES_PER_DOC / 2; // 2000

function setColor(boxes: Uint8Array, arrayIdx: number, color: number): void {
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  boxes[byteIdx] = arrayIdx % 2 === 0
    ? (byte & 0xf0) | (color & 0x0f)
    : (byte & 0x0f) | ((color & 0x0f) << 4);
}

// Read export file
const raw = fs.readFileSync(IN_FILE, 'utf-8');
const colored: Array<{ g: number; c: number }> = JSON.parse(raw);
console.log(`Loaded ${colored.length} colored checkboxes from ${IN_FILE}`);

// Remap to new layout and group by new document index
const newDocs = new Map<number, Uint8Array>();

for (const { g: globalIndex, c: color } of colored) {
  const newDocIdx = globalIndex % NEW_NUM_DOCUMENTS;
  const newArrayIdx = Math.floor(globalIndex / NEW_NUM_DOCUMENTS);

  if (newArrayIdx >= NEW_BOXES_PER_DOC) {
    console.warn(`Skipping globalIndex ${globalIndex}: arrayIdx ${newArrayIdx} >= ${NEW_BOXES_PER_DOC}`);
    continue;
  }

  if (!newDocs.has(newDocIdx)) {
    newDocs.set(newDocIdx, new Uint8Array(NEW_BYTES_PER_DOC));
  }
  setColor(newDocs.get(newDocIdx)!, newArrayIdx, color);
}

console.log(`Remapped to ${newDocs.size} new documents. Connecting...`);

const BATCH_SIZE = 50; // documents per reducer call

const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(TOKEN)
  .withConfirmedReads(false)
  .onConnect(async () => {
    console.log('Connected. Importing...');

    const entries = [...newDocs.entries()];
    let imported = 0;

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);

      // Call import_boxes for each document in the batch
      const promises = batch.map(([idx, boxes]) =>
        conn.reducers.importBoxes({ idx, boxes }).catch((err: Error) => {
          console.error(`Failed to import doc ${idx}:`, err.message);
        })
      );

      await Promise.all(promises);
      imported += batch.length;

      if (imported % 500 === 0 || imported === entries.length) {
        console.log(`Imported ${imported} / ${entries.length} documents`);
      }
    }

    console.log('Import complete!');
    process.exit(0);
  })
  .onConnectError((_ctx, err) => {
    console.error('Connection error:', err);
    process.exit(1);
  })
  .build();
