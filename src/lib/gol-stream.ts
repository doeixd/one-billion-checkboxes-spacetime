import type { DbConnection, EventContext, SubscriptionHandle } from "../module_bindings/index.ts";
import type { GolDiffV2, GolLoopStatus, GolRowChunk, GolSync } from "../module_bindings/types.ts";
import { createAsyncQueue } from "./streams.ts";

export type GolStreamPhase = "syncing" | "resyncing" | "live";

export type GolBoardEvent =
  | { kind: "phase"; phase: GolStreamPhase }
  | { kind: "snapshot-ready"; rows: Map<number, Uint8Array>; generation: bigint; version: bigint }
  | { kind: "diff"; version: bigint; data: Uint8Array }
  | { kind: "sync"; generation: bigint; version: bigint }
  | { kind: "loop-status"; loopPeriod: number };

const PHASE1_QUERIES = [
  "SELECT * FROM gol_row_chunk",
  "SELECT * FROM gol_sync",
  "SELECT * FROM gol_loop_status",
];

const PHASE2_QUERIES = [
  "SELECT * FROM gol_diff_v2",
  "SELECT * FROM gol_sync",
  "SELECT * FROM gol_loop_status",
];

const cloneRows = (rows: Map<number, Uint8Array>) =>
  new Map(Array.from(rows, ([rowIdx, data]) => [rowIdx, new Uint8Array(data)]));

export function golBoardStream(options: {
  conn: DbConnection;
  signal?: AbortSignal;
}): AsyncIterable<GolBoardEvent> {
  const { conn, signal } = options;

  return {
    async *[Symbol.asyncIterator]() {
      const queue = createAsyncQueue<GolBoardEvent>(signal);
      const snapshotRows = new Map<number, Uint8Array>();

      let phase1Handle: SubscriptionHandle | null = null;
      let phase2Handle: SubscriptionHandle | null = null;
      let phase2Live = false;
      let disposed = false;
      let subGeneration = 0;
      let latestVersion = 0n;
      let latestGeneration = 0n;
      let lastAppliedVersion = 0n;

      const safeUnsub = (handle: SubscriptionHandle | null) => {
        if (!handle) return;
        try {
          handle.unsubscribe();
        } catch {}
      };

      const resetSyncState = (phase: Exclude<GolStreamPhase, "live">) => {
        snapshotRows.clear();
        phase2Live = false;
        latestVersion = 0n;
        latestGeneration = 0n;
        lastAppliedVersion = 0n;
        queue.push({ kind: "phase", phase });
      };

      const startSubscriptions = (phase: Exclude<GolStreamPhase, "live">) => {
        if (disposed) return;

        safeUnsub(phase1Handle);
        safeUnsub(phase2Handle);
        resetSyncState(phase);

        const gen = ++subGeneration;

        const p1Handle = conn
          .subscriptionBuilder()
          .onError(ctx => queue.error(ctx.event ?? new Error("GOL phase 1 subscription failed")))
          .onApplied(() => {
            if (disposed || gen !== subGeneration) {
              safeUnsub(p1Handle);
              return;
            }

            phase2Handle = conn
              .subscriptionBuilder()
              .onError(ctx => queue.error(ctx.event ?? new Error("GOL phase 2 subscription failed")))
              .onApplied(() => {
                if (disposed || gen !== subGeneration) return;
                phase2Live = true;
                queue.push({
                  kind: "snapshot-ready",
                  rows: cloneRows(snapshotRows),
                  generation: latestGeneration,
                  version: latestVersion,
                });
                queue.push({ kind: "phase", phase: "live" });
                safeUnsub(p1Handle);
                if (phase1Handle === p1Handle) phase1Handle = null;
              })
              .subscribe(PHASE2_QUERIES);
          })
          .subscribe(PHASE1_QUERIES);

        phase1Handle = p1Handle;
      };

      const handleChunk = (row: GolRowChunk) => {
        if (disposed) return;
        snapshotRows.set(row.rowIdx, new Uint8Array(row.cells as Uint8Array));
      };

      const handleSync = (row: GolSync) => {
        if (disposed) return;
        latestVersion = row.version;
        latestGeneration = row.generation;
        queue.push({
          kind: "sync",
          generation: row.generation,
          version: row.version,
        });
      };

      const handleLoop = (row: GolLoopStatus) => {
        if (disposed) return;
        queue.push({ kind: "loop-status", loopPeriod: row.loopPeriod });
      };

      const maybeApplyDiff = (row: GolDiffV2) => {
        if (disposed || !phase2Live) return;
        if (row.version <= lastAppliedVersion) return;
        if (row.version !== lastAppliedVersion + 1n) {
          startSubscriptions("resyncing");
          return;
        }
        lastAppliedVersion = row.version;
        queue.push({
          kind: "diff",
          version: row.version,
          data: new Uint8Array(row.data as Uint8Array),
        });
      };

      const handleChunkInsert = (_ctx: EventContext, row: GolRowChunk) => handleChunk(row);
      const handleChunkUpdate = (_ctx: EventContext, _old: GolRowChunk, row: GolRowChunk) => handleChunk(row);
      const handleDiffInsert = (_ctx: EventContext, row: GolDiffV2) => maybeApplyDiff(row);
      const handleDiffUpdate = (_ctx: EventContext, _old: GolDiffV2, row: GolDiffV2) => maybeApplyDiff(row);
      const handleSyncInsert = (_ctx: EventContext, row: GolSync) => handleSync(row);
      const handleSyncUpdate = (_ctx: EventContext, _old: GolSync, row: GolSync) => handleSync(row);
      const handleLoopInsert = (_ctx: EventContext, row: GolLoopStatus) => handleLoop(row);
      const handleLoopUpdate = (_ctx: EventContext, _old: GolLoopStatus, row: GolLoopStatus) => handleLoop(row);

      conn.db.golRowChunk.onInsert(handleChunkInsert);
      conn.db.golRowChunk.onUpdate(handleChunkUpdate);
      conn.db.golDiffV2.onInsert(handleDiffInsert);
      conn.db.golDiffV2.onUpdate(handleDiffUpdate);
      conn.db.golSync.onInsert(handleSyncInsert);
      conn.db.golSync.onUpdate(handleSyncUpdate);
      conn.db.golLoopStatus.onInsert(handleLoopInsert);
      conn.db.golLoopStatus.onUpdate(handleLoopUpdate);

      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        safeUnsub(phase1Handle);
        safeUnsub(phase2Handle);
        conn.db.golRowChunk.removeOnInsert(handleChunkInsert);
        conn.db.golRowChunk.removeOnUpdate(handleChunkUpdate);
        conn.db.golDiffV2.removeOnInsert(handleDiffInsert);
        conn.db.golDiffV2.removeOnUpdate(handleDiffUpdate);
        conn.db.golSync.removeOnInsert(handleSyncInsert);
        conn.db.golSync.removeOnUpdate(handleSyncUpdate);
        conn.db.golLoopStatus.removeOnInsert(handleLoopInsert);
        conn.db.golLoopStatus.removeOnUpdate(handleLoopUpdate);
        queue.close();
      };

      signal?.addEventListener("abort", cleanup, { once: true });

      startSubscriptions("syncing");

      try {
        for await (const event of queue.iterable) {
          if (event.kind === "snapshot-ready") {
            lastAppliedVersion = event.version;
          }
          yield event;
        }
      } finally {
        cleanup();
      }
    },
  };
}
