import type { Setter, StoreSetter } from "solid-js";
import type { CheckboxChanges, Checkboxes, Stats } from "../module_bindings/types.ts";

type BoxesByDocument = Record<number, Uint8Array>;
type PendingByDocument = Record<number, Record<number, number>>;

const BYTES_PER_DOCUMENT = 2000;

/**
 * One cell with unacknowledged toggles.
 *
 * `delta` is the cell's net contribution to the optimistic colored-count
 * (sum of +1/-1 over the in-flight toggles). It is reverted verbatim when the
 * cell's optimistic state is dropped, and zeroed once the server confirms —
 * after a confirmation the contribution belongs to the base count until the
 * next stats sync, so it must never be reverted.
 */
export interface InflightCell {
  time: number;
  count: number;
  delta: number;
  color: number;
}

function getColorLocal(boxes: ArrayLike<number>, arrayIdx: number): number {
  const byte = boxes[Math.floor(arrayIdx / 2)] || 0;
  return arrayIdx % 2 === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
}

function setColorLocal(boxes: Uint8Array, arrayIdx: number, color: number): void {
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  boxes[byteIdx] = arrayIdx % 2 === 0
    ? (byte & 0xf0) | (color & 0x0f)
    : (byte & 0x0f) | ((color & 0x0f) << 4);
}

export function createCheckboxStateController(options: {
  rawBoxes: BoxesByDocument;
  pendingStore: PendingByDocument;
  setBoxesStore: StoreSetter<BoxesByDocument>;
  setPendingStore: StoreSetter<PendingByDocument>;
  inflightCells: Map<string, InflightCell>;
  setPendingToggleCount: Setter<number>;
  setLastRoundTripMs: Setter<number | null>;
  setTotalColored: Setter<bigint>;
  setPendingCountDelta: Setter<number>;
  /** Called whenever the rendered board data changes, to trigger a repaint. */
  onChange?: () => void;
  roundTripFadeMs?: number;
}) {
  const roundTripFadeMs = options.roundTripFadeMs ?? 2000;
  let roundTripFadeTimer = 0;

  const setRoundTrip = (ms: number) => {
    options.setLastRoundTripMs(ms);
    clearTimeout(roundTripFadeTimer);
    roundTripFadeTimer = window.setTimeout(() => options.setLastRoundTripMs(null), roundTripFadeMs);
  };

  const clearPending = (documentIdx: number, arrayIdx: number, onlyIfColor?: number) => {
    if (options.pendingStore[documentIdx]?.[arrayIdx] === undefined) return;
    if (onlyIfColor !== undefined && options.pendingStore[documentIdx][arrayIdx] !== onlyIfColor) return;
    options.setPendingStore(s => {
      const doc = s[documentIdx];
      if (!doc) return;
      delete doc[arrayIdx];
      if (Object.keys(doc).length === 0) delete s[documentIdx];
    });
  };

  /** Record an optimistic toggle for a cell, before it is sent to the server. */
  const noteToggle = (documentIdx: number, arrayIdx: number, color: number, delta: number) => {
    const cellKey = `${documentIdx}:${arrayIdx}`;
    const existing = options.inflightCells.get(cellKey);
    options.inflightCells.set(cellKey, {
      time: existing?.time ?? performance.now(),
      count: (existing?.count ?? 0) + 1,
      delta: (existing?.delta ?? 0) + delta,
      color,
    });
    options.setPendingToggleCount(c => c + 1);
    if (delta !== 0) options.setPendingCountDelta(d => d + delta);
    options.onChange?.();
  };

  /**
   * Abandon a cell's optimistic state: the toggle failed, or its confirmation
   * never arrived. Undoes the pending overlay, the pending-toggle counter and
   * the optimistic count contribution together, so none of them can drift.
   *
   * If a dropped toggle did in fact land, its change event is later treated as
   * a foreign change and re-counted — so the total stays right either way.
   */
  const dropInflight = (documentIdx: number, arrayIdx: number) => {
    const cellKey = `${documentIdx}:${arrayIdx}`;
    const inflight = options.inflightCells.get(cellKey);
    if (!inflight) return;

    options.inflightCells.delete(cellKey);
    options.setPendingToggleCount(c => Math.max(0, c - inflight.count));
    if (inflight.delta !== 0) options.setPendingCountDelta(d => d - inflight.delta);
    clearPending(documentIdx, arrayIdx, inflight.color);
    options.onChange?.();
  };

  /** Mark a cell's in-flight toggles as acknowledged by the server. */
  const confirmInflight = (cellKey: string, inflight: InflightCell, resolvedCount: number) => {
    const remaining = inflight.count - resolvedCount;
    options.setPendingToggleCount(c => Math.max(0, c - resolvedCount));
    if (remaining <= 0) {
      options.inflightCells.delete(cellKey);
      setRoundTrip(Math.round(performance.now() - inflight.time));
    } else {
      // The confirmed contribution is now part of the base count — never revert it.
      options.inflightCells.set(cellKey, { ...inflight, count: remaining, delta: 0 });
    }
  };

  const upsertRow = (row: Checkboxes) => {
    options.rawBoxes[row.idx] = row.boxes;
    options.setBoxesStore(s => {
      s[row.idx] = row.boxes;
    });

    const pendingDoc = options.pendingStore[row.idx];
    const resolvedPending = new Set<number>();
    if (pendingDoc) {
      for (const [arrayIdxStr, pendingColor] of Object.entries(pendingDoc)) {
        const arrayIdx = Number(arrayIdxStr);
        if (getColorLocal(row.boxes, arrayIdx) === pendingColor) {
          resolvedPending.add(arrayIdx);
        }
      }

      options.setPendingStore(s => {
        const current = s[row.idx];
        if (!current) return;

        for (const arrayIdx of resolvedPending) {
          delete current[arrayIdx];
        }

        if (Object.keys(current).length === 0) {
          delete s[row.idx];
        }
      });
    }

    const prefix = `${row.idx}:`;
    for (const [key, inflight] of options.inflightCells) {
      if (!key.startsWith(prefix)) continue;
      const arrayIdx = Number(key.slice(prefix.length));
      if (Number.isNaN(arrayIdx)) continue;
      if (pendingDoc?.[arrayIdx] !== undefined && !resolvedPending.has(arrayIdx)) continue;
      confirmInflight(key, inflight, inflight.count);
    }

    options.onChange?.();
  };

  const applyChange = (change: CheckboxChanges) => {
    const { documentIdx, arrayIdx, color } = change;
    const existing = options.rawBoxes[documentIdx];

    const cellKey = `${documentIdx}:${arrayIdx}`;
    const inflight = options.inflightCells.get(cellKey);
    // A change for a cell we have toggles in flight for was already counted at
    // click time. Anything else has not been counted yet: another user, or a
    // toggle of ours whose optimistic state was dropped. Keying this off the
    // in-flight record rather than the pending colour matters when the same
    // cell is toggled twice in a row — the first echo no longer matches the
    // overlay, but it is still ours and must not be counted twice.
    const isOwn = inflight !== undefined;
    const previousColor = existing ? getColorLocal(existing, arrayIdx) : 0;

    if (existing) {
      setColorLocal(existing, arrayIdx, color);
      options.setBoxesStore(s => {
        s[documentIdx] = new Uint8Array(existing);
      });
    } else {
      const boxes = new Uint8Array(BYTES_PER_DOCUMENT);
      setColorLocal(boxes, arrayIdx, color);
      options.rawBoxes[documentIdx] = boxes;
      options.setBoxesStore(s => {
        s[documentIdx] = new Uint8Array(boxes);
      });
    }

    if (!isOwn) {
      const delta = (color > 0 ? 1 : 0) - (previousColor > 0 ? 1 : 0);
      if (delta !== 0) options.setPendingCountDelta(d => d + delta);
    }

    clearPending(documentIdx, arrayIdx, color);

    if (inflight) confirmInflight(cellKey, inflight, 1);

    options.onChange?.();
  };

  const upsertStats = (row: Stats) => {
    options.setTotalColored(row.totalColored);
    options.setPendingCountDelta(0);
  };

  const cleanup = () => {
    clearTimeout(roundTripFadeTimer);
  };

  return {
    upsertRow,
    applyChange,
    upsertStats,
    noteToggle,
    dropInflight,
    cleanup,
  };
}
