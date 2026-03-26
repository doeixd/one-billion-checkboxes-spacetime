import type { Setter, StoreSetter } from "solid-js";
import type { CheckboxChanges, Checkboxes, Stats } from "../module_bindings/types.ts";

type BoxesByDocument = Record<number, Uint8Array>;
type PendingByDocument = Record<number, Record<number, number>>;

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
  inflightCells: Map<string, { time: number; count: number }>;
  setPendingToggleCount: Setter<number>;
  setLastRoundTripMs: Setter<number | null>;
  setTotalColored: Setter<bigint>;
  setPendingCountDelta: Setter<number>;
  roundTripFadeMs?: number;
}) {
  const roundTripFadeMs = options.roundTripFadeMs ?? 2000;
  let roundTripFadeTimer = 0;

  const setRoundTrip = (ms: number) => {
    options.setLastRoundTripMs(ms);
    clearTimeout(roundTripFadeTimer);
    roundTripFadeTimer = window.setTimeout(() => options.setLastRoundTripMs(null), roundTripFadeMs);
  };

  const upsertRow = (row: Checkboxes) => {
    options.rawBoxes[row.idx] = row.boxes;
    options.setBoxesStore(s => {
      s[row.idx] = row.boxes;
    });

    if (options.pendingStore[row.idx]) {
      options.setPendingStore(s => {
        delete s[row.idx];
      });
    }

    const prefix = `${row.idx}:`;
    for (const [key, inflight] of options.inflightCells) {
      if (!key.startsWith(prefix)) continue;
      options.inflightCells.delete(key);
      setRoundTrip(Math.round(performance.now() - inflight.time));
      options.setPendingToggleCount(c => Math.max(0, c - inflight.count));
    }
  };

  const applyChange = (change: CheckboxChanges) => {
    const { documentIdx, arrayIdx, color } = change;
    const existing = options.rawBoxes[documentIdx];

    if (existing) {
      setColorLocal(existing, arrayIdx, color);
      options.setBoxesStore(s => {
        s[documentIdx] = new Uint8Array(existing);
      });
    } else {
      const boxes = new Uint8Array(2000);
      setColorLocal(boxes, arrayIdx, color);
      options.rawBoxes[documentIdx] = boxes;
      options.setBoxesStore(s => {
        s[documentIdx] = new Uint8Array(boxes);
      });
    }

    if (options.pendingStore[documentIdx]?.[arrayIdx] !== undefined) {
      options.setPendingStore(s => {
        if (!s[documentIdx]) return;
        delete s[documentIdx][arrayIdx];
        if (Object.keys(s[documentIdx]).length === 0) {
          delete s[documentIdx];
        }
      });
    }

    const cellKey = `${documentIdx}:${arrayIdx}`;
    const inflight = options.inflightCells.get(cellKey);
    if (!inflight) return;

    const newCount = inflight.count - 1;
    options.setPendingToggleCount(c => Math.max(0, c - 1));

    if (newCount <= 0) {
      options.inflightCells.delete(cellKey);
      setRoundTrip(Math.round(performance.now() - inflight.time));
      return;
    }

    options.inflightCells.set(cellKey, { ...inflight, count: newCount });
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
    cleanup,
  };
}
