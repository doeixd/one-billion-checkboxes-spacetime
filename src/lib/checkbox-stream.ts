import type { DbConnection, SubscriptionHandle } from "../module_bindings/index.ts";
import { createAsyncQueue } from "./streams.ts";

export interface CheckboxDocRange {
  min: number;
  max: number;
  wraps: boolean;
}

export type CheckboxRangePhase = "syncing" | "live";

export type CheckboxRangeEvent =
  | { kind: "phase"; phase: CheckboxRangePhase; range: CheckboxDocRange }
  | { kind: "snapshot-ready"; range: CheckboxDocRange };

const fullQueries = (range: CheckboxDocRange) =>
  range.wraps
    ? [
        `SELECT * FROM checkboxes WHERE idx >= ${range.min}`,
        `SELECT * FROM checkboxes WHERE idx <= ${range.max}`,
        "SELECT * FROM checkbox_sync",
      ]
    : [
        `SELECT * FROM checkboxes WHERE idx >= ${range.min} AND idx <= ${range.max}`,
        "SELECT * FROM checkbox_sync",
      ];

const changeQueries = (range: CheckboxDocRange, latestChangeId: bigint) =>
  range.wraps
    ? [
        `SELECT * FROM checkbox_changes WHERE document_idx >= ${range.min} AND id > ${latestChangeId}`,
        `SELECT * FROM checkbox_changes WHERE document_idx <= ${range.max} AND id > ${latestChangeId}`,
      ]
    : [`SELECT * FROM checkbox_changes WHERE document_idx >= ${range.min} AND document_idx <= ${range.max} AND id > ${latestChangeId}`];

export function checkboxRangeStream(options: {
  conn: DbConnection;
  range: CheckboxDocRange;
  signal?: AbortSignal;
}): AsyncIterable<CheckboxRangeEvent> {
  const { conn, range, signal } = options;

  return {
    async *[Symbol.asyncIterator]() {
      const queue = createAsyncQueue<CheckboxRangeEvent>(signal);
      let phase1Handle: SubscriptionHandle | null = null;
      let phase2Handle: SubscriptionHandle | null = null;
      let disposed = false;

      const safeUnsub = (handle: SubscriptionHandle | null) => {
        if (!handle) return;
        try {
          if (!handle.isEnded()) handle.unsubscribe();
        } catch {}
      };

      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        safeUnsub(phase1Handle);
        safeUnsub(phase2Handle);
        queue.close();
      };

      signal?.addEventListener("abort", cleanup, { once: true });

      queue.push({ kind: "phase", phase: "syncing", range });

      phase1Handle = conn
        .subscriptionBuilder()
        .onError(ctx => queue.error(ctx.event ?? new Error("Checkbox bootstrap subscription failed")))
        .onApplied(() => {
          if (disposed) return;

          const sync = conn.db.checkboxSync.id.find(0);
          const latestChangeId = sync?.latestChangeId ?? 0n;

          queue.push({ kind: "snapshot-ready", range });

          phase2Handle = conn
            .subscriptionBuilder()
            .onError(ctx => queue.error(ctx.event ?? new Error("Checkbox diff subscription failed")))
            .onApplied(() => {
              if (disposed) return;
              queue.push({ kind: "phase", phase: "live", range });
              safeUnsub(phase1Handle);
              if (phase1Handle && phase1Handle.isEnded()) {
                phase1Handle = null;
              }
            })
            .subscribe(changeQueries(range, latestChangeId));
        })
        .subscribe(fullQueries(range));

      try {
        yield* queue.iterable;
      } finally {
        cleanup();
      }
    },
  };
}
