import type { DbConnection, EventContext, SubscriptionHandle } from "../module_bindings/index.ts";
import type { GolDiffLog, GolSync } from "../module_bindings/types.ts";
import { createAsyncQueue } from "./streams.ts";

export type GolStreamPhase = "syncing" | "resyncing" | "live";

export type GolBoardEvent =
  | { kind: "phase"; phase: GolStreamPhase }
  | { kind: "snapshot-ready"; cells: Uint8Array; generation: bigint; version: bigint }
  | { kind: "diff"; version: bigint; data: Uint8Array }
  | { kind: "sync"; generation: bigint; version: bigint };

const SNAPSHOT_QUERIES = [
  "SELECT * FROM gol_bootstrap",
];

const LIVE_QUERIES = [
  "SELECT * FROM gol_sync",
];

const GOL_GRID_BYTES = 1250;
const PERIODIC_RESYNC_MS = 20_000;

export function golBoardStream(options: {
  conn: DbConnection;
  signal?: AbortSignal;
}): AsyncIterable<GolBoardEvent> {
  const { conn, signal } = options;

  const readSnapshot = () => {
    const snapshot = conn.db.golBootstrap.id.find(0);
    if (!snapshot || (snapshot.cells as Uint8Array).length !== GOL_GRID_BYTES) return null;

    return {
      cells: new Uint8Array(snapshot.cells as Uint8Array),
      generation: snapshot.generation,
      version: snapshot.version,
    };
  };

  const readPendingDiffs = () =>
    [...conn.db.golDiffLog.iter()]
      .map(row => ({ version: row.version, data: new Uint8Array(row.data as Uint8Array) }))
      .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));

  return {
    async *[Symbol.asyncIterator]() {
      const queue = createAsyncQueue<GolBoardEvent>(signal);

      let snapshotHandle: SubscriptionHandle | null = null;
      let liveHandle: SubscriptionHandle | null = null;
      let subscriptionLive = false;
      let disposed = false;
      let subGeneration = 0;
      let lastAppliedVersion = 0n;
      let pendingSync: GolSync | null = null;
      let periodicResyncTimer = 0;

      const safeUnsub = (handle: SubscriptionHandle | null) => {
        if (!handle) return;
        try {
          if (!handle.isEnded()) handle.unsubscribe();
        } catch {}
      };

      const resetSyncState = (phase: Exclude<GolStreamPhase, "live">) => {
        subscriptionLive = false;
        lastAppliedVersion = 0n;
        pendingSync = null;
        queue.push({ kind: "phase", phase });
      };

      const maybeFlushPendingSync = () => {
        if (!pendingSync) return;
        if (pendingSync.version > lastAppliedVersion) return;
        queue.push({
          kind: "sync",
          generation: pendingSync.generation,
          version: pendingSync.version,
        });
        pendingSync = null;
      };

      const startSubscriptions = (phase: Exclude<GolStreamPhase, "live">) => {
        if (disposed) return;

        const previousSnapshotHandle = snapshotHandle;
        const previousLiveHandle = liveHandle;
        snapshotHandle = null;
        liveHandle = null;
        resetSyncState(phase);

        const gen = ++subGeneration;

        snapshotHandle = conn
          .subscriptionBuilder()
          .onError(ctx => queue.error(ctx.event ?? new Error("GOL bootstrap subscription failed")))
          .onApplied(() => {
            if (disposed || gen !== subGeneration) return;
            const bootstrapSnapshot = readSnapshot();
            if (!bootstrapSnapshot) {
              startSubscriptions("resyncing");
              return;
            }

            liveHandle = conn
              .subscriptionBuilder()
              .onError(ctx => queue.error(ctx.event ?? new Error("GOL live subscription failed")))
              .onApplied(() => {
                if (disposed || gen !== subGeneration) return;

                const snapshot = readSnapshot();
                if (!snapshot) {
                  startSubscriptions("resyncing");
                  return;
                }

                lastAppliedVersion = snapshot.version;
                queue.push({
                  kind: "snapshot-ready",
                  cells: snapshot.cells,
                  generation: snapshot.generation,
                  version: snapshot.version,
                });

                const pendingDiffs = readPendingDiffs();
                for (const diff of pendingDiffs) {
                  if (diff.version <= lastAppliedVersion) continue;
                  if (diff.version !== lastAppliedVersion + 1n) {
                    startSubscriptions("resyncing");
                    return;
                  }

                  lastAppliedVersion = diff.version;
                  queue.push({
                    kind: "diff",
                    version: diff.version,
                    data: diff.data,
                  });
                }

                subscriptionLive = true;
                queue.push({ kind: "phase", phase: "live" });

                const currentSync = conn.db.golSync.id.find(0);
                if (currentSync) {
                  pendingSync = currentSync;
                  maybeFlushPendingSync();
                }

                safeUnsub(previousSnapshotHandle);
                safeUnsub(previousLiveHandle);
                safeUnsub(snapshotHandle);
                if (snapshotHandle?.isEnded()) snapshotHandle = null;
              })
              .subscribe([
                `SELECT * FROM gol_diff_log WHERE version > ${bootstrapSnapshot.version}`,
                ...LIVE_QUERIES,
              ]);
          })
          .subscribe(SNAPSHOT_QUERIES);
      };

      const maybeApplyDiff = (row: GolDiffLog) => {
        if (disposed || !subscriptionLive) return;
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
        maybeFlushPendingSync();
      };

      const handleDiffInsert = (_ctx: EventContext, row: GolDiffLog) => maybeApplyDiff(row);
      const handleDiffUpdate = (_ctx: EventContext, _old: GolDiffLog, row: GolDiffLog) => maybeApplyDiff(row);
      const handleSyncInsert = (_ctx: EventContext, row: GolSync) => {
        if (disposed || !subscriptionLive) return;
        pendingSync = row;
        maybeFlushPendingSync();
      };
      const handleSyncUpdate = (_ctx: EventContext, _old: GolSync, row: GolSync) => {
        if (disposed || !subscriptionLive) return;
        pendingSync = row;
        maybeFlushPendingSync();
      };

      conn.db.golDiffLog.onInsert(handleDiffInsert);
      conn.db.golDiffLog.onUpdate(handleDiffUpdate);
      conn.db.golSync.onInsert(handleSyncInsert);
      conn.db.golSync.onUpdate(handleSyncUpdate);

      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        clearInterval(periodicResyncTimer);
        safeUnsub(snapshotHandle);
        safeUnsub(liveHandle);
        conn.db.golDiffLog.removeOnInsert(handleDiffInsert);
        conn.db.golDiffLog.removeOnUpdate(handleDiffUpdate);
        conn.db.golSync.removeOnInsert(handleSyncInsert);
        conn.db.golSync.removeOnUpdate(handleSyncUpdate);
        queue.close();
      };

      signal?.addEventListener("abort", cleanup, { once: true });

      periodicResyncTimer = window.setInterval(() => {
        if (disposed || !subscriptionLive) return;
        startSubscriptions("resyncing");
      }, PERIODIC_RESYNC_MS);

      startSubscriptions("syncing");

      try {
        for await (const event of queue.iterable) {
          yield event;
        }
      } finally {
        cleanup();
      }
    },
  };
}
