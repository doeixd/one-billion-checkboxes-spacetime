/**
 * Main UI — renders a virtual grid of 1,000,000,000 checkboxes.
 *
 * Data model:
 *   1B checkboxes across 250,000 DB rows ("documents").
 *   Each document holds 4,000 checkboxes packed as nibbles (4 bits, 2 per byte).
 *   Nibble 0 = unchecked; 1-15 = color index. Missing rows are all-zero.
 *   Checkbox N maps to: documentIdx = N % 250000, arrayIdx = floor(N / 250000).
 *
 * Rendering:
 *   A fixed pool of real DOM elements fills the viewport + overscan. On scroll,
 *   each cell's reactive index updates; SolidJS's fine-grained reactivity only
 *   touches DOM nodes whose color actually changed. CSS transitions, hover
 *   states, and accessibility come free from real elements.
 */
import {
  createSignal,
  createMemo,
  createEffect,
  isPending,
  onSettled,
  onCleanup,
  For,
  Show,
  Loading,
} from "solid-js";
import { conn, isConnected } from "./main.tsx";
import type { EventContext } from "./module_bindings/index.ts";
import type { Checkboxes } from "./module_bindings/types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_BOXES = 1_000_000_000;
const NUM_DOCUMENTS = 250_000;
const CELL_SIZE = 22; // px
const OVERSCAN = 3; // extra rows above/below viewport

const PALETTE: string[] = [
  "#f3f4f6", // 0: clear / uncheck
  "#111827", // 1: near-black
  "#dc2626", // 2: red
  "#ea580c", // 3: orange
  "#d97706", // 4: amber
  "#16a34a", // 5: green
  "#0891b2", // 6: cyan
  "#2563eb", // 7: blue
  "#7c3aed", // 8: purple
  "#db2777", // 9: pink
  "#f87171", // 10: light red
  "#fb923c", // 11: light orange
  "#fbbf24", // 12: yellow
  "#4ade80", // 13: light green
  "#38bdf8", // 14: sky blue
  "#a78bfa", // 15: lavender
];

// ─── Nibble helpers ────────────────────────────────────────────────────────────

function getColor(boxes: number[], arrayIdx: number): number {
  const byte = boxes[Math.floor(arrayIdx / 2)] || 0;
  return arrayIdx % 2 === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
}

function countColored(boxes: number[]): number {
  let count = 0;
  for (let i = 0; i < boxes.length; i++) {
    const byte = boxes[i];
    if (byte === 0) continue;
    if (byte & 0x0f) count++;
    if (byte >> 4) count++;
  }
  return count;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  // ── Data state ──────────────────────────────────────────────────────────
  const [boxesMap, setBoxesMap] = createSignal(new Map<number, number[]>(), {
    equals: false,
  });

  const [numCheckedBoxes, setNumCheckedBoxes] = createSignal(0);
  const docColorCounts = new Map<number, number>();

  // ── Async subscription + canvas readiness ─────────────────────────────
  let resolveSubscription!: () => void;
  const subscriptionPromise = new Promise<void>((res) => {
    resolveSubscription = res;
  });

  const [containerMeasured, setContainerMeasured] = createSignal(false);

  const gridReady = createMemo(async () => {
    await subscriptionPromise;
    await new Promise<void>((res) => {
      const check = () => {
        if (containerMeasured()) {
          res();
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
    return true as const;
  });

  const isSyncing = () => isPending(() => gridReady());


  // ── Pending optimistic writes ─────────────────────────────────────────
  const [pendingUpdates, setPendingUpdates] = createSignal(
    new Map<number, Map<number, number>>(),
  );

  // ── Round-trip timing ─────────────────────────────────────────────────
  const inflightDocs = new Map<number, { time: number; count: number }>();
  const [pendingToggleCount, setPendingToggleCount] = createSignal(0);
  const [lastRoundTripMs, setLastRoundTripMs] = createSignal<number | null>(
    null,
  );
  let roundTripFadeTimer = 0;

  // ── UI state ──────────────────────────────────────────────────────────
  const [selectedColor, setSelectedColor] = createSignal(1);

  // ── Virtual scroll state ──────────────────────────────────────────────
  let containerRef!: HTMLDivElement;
  let scrollRef!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = createSignal(0);

  // ── One-time setup after mount ────────────────────────────────────────
  let rafId = 0;

  onSettled(() => {
    const obs = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) {
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
        if (!containerMeasured()) setContainerMeasured(true);
      }
    });
    obs.observe(containerRef);

    onCleanup(() => {
      obs.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(roundTripFadeTimer);
    });

    // SpacetimeDB event handlers
    const upsertRow = (row: Checkboxes) => {
      const boxes = Array.from(row.boxes);
      setBoxesMap((map) => {
        map.set(row.idx, boxes);
        return map;
      });

      const newCount = countColored(boxes);
      const oldCount = docColorCounts.get(row.idx) ?? 0;
      docColorCounts.set(row.idx, newCount);
      setNumCheckedBoxes((prev) => prev + newCount - oldCount);

      setPendingUpdates((prev) => {
        if (!prev.has(row.idx)) return prev;
        const next = new Map(prev);
        next.delete(row.idx);
        return next;
      });

      const inflight = inflightDocs.get(row.idx);
      if (inflight) {
        inflightDocs.delete(row.idx);
        const ms = Math.round(performance.now() - inflight.time);
        setLastRoundTripMs(ms);
        setPendingToggleCount((c) => Math.max(0, c - inflight.count));

        clearTimeout(roundTripFadeTimer);
        roundTripFadeTimer = window.setTimeout(
          () => setLastRoundTripMs(null),
          2000,
        );
      }
    };

    conn.db.checkboxes.onInsert((_ctx: EventContext, row: Checkboxes) =>
      upsertRow(row),
    );
    conn.db.checkboxes.onUpdate(
      (_ctx: EventContext, _old: Checkboxes, row: Checkboxes) => upsertRow(row),
    );

    conn.db.checkboxes.onDelete((_ctx: EventContext, row: Checkboxes) => {
      setBoxesMap((map) => {
        map.delete(row.idx);
        return map;
      });
      const oldCount = docColorCounts.get(row.idx) ?? 0;
      docColorCounts.delete(row.idx);
      setNumCheckedBoxes((prev) => prev - oldCount);
    });

    conn
      .subscriptionBuilder()
      .onApplied(() => resolveSubscription())
      .subscribe(["SELECT * FROM checkboxes"]);
  });

  // ── Derived scroll values ─────────────────────────────────────────────
  const [scrollbarWidth, setScrollbarWidth] = createSignal(0);
  const numColumns = () =>
    Math.max(1, Math.floor((size().width - scrollbarWidth()) / CELL_SIZE));
  const numRows = () => Math.ceil(NUM_BOXES / numColumns());
  const totalHeight = () => numRows() * CELL_SIZE;

  // The first visible row (with overscan above)
  const startRow = () =>
    Math.max(0, Math.floor(scrollTop() / CELL_SIZE) - OVERSCAN);

  // How many rows fit in the viewport + overscan on both sides
  const poolRows = () => {
    const visible = Math.ceil(size().height / CELL_SIZE);
    return Math.min(visible + OVERSCAN * 2, numRows());
  };

  // Fixed pool of local row indices [0, 1, 2, ... poolRows-1]
  const rowPool = createMemo(() =>
    Array.from({ length: poolRows() }, (_, i) => i),
  );

  // Fixed pool of column indices [0, 1, 2, ... numColumns-1]
  const colPool = createMemo(() =>
    Array.from({ length: numColumns() }, (_, i) => i),
  );

  // ── Side effects ──────────────────────────────────────────────────────

  createEffect(
    () => numCheckedBoxes(),
    (count) => {
      document.title = `${count.toLocaleString()} colored — One Billion Checkboxes`;
    },
  );

  // ── Scroll handler (rAF-throttled) ────────────────────────────────────
  const onScroll = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      if (!scrollRef) return;
      setScrollTop(scrollRef.scrollTop);
      setScrollbarWidth(scrollRef.offsetWidth - scrollRef.clientWidth);
    });
  };

  // ── Toggle handler ────────────────────────────────────────────────────
  const loading = () => !isConnected() || !gridReady();

  /** Look up effective color for a cell (pending overlay first, then base). */
  const getCellColor = (documentIdx: number, arrayIdx: number): number => {
    const docPending = pendingUpdates().get(documentIdx);
    if (docPending?.has(arrayIdx)) return docPending.get(arrayIdx)!;
    const docBoxes = boxesMap().get(documentIdx);
    return docBoxes ? getColor(docBoxes, arrayIdx) : 0;
  };

  const toggle = (documentIdx: number, arrayIdx: number) => {
    if (loading()) return;

    const currentColor = getCellColor(documentIdx, arrayIdx);
    const newColor =
      currentColor === selectedColor() && selectedColor() !== 0
        ? 0
        : selectedColor();

    setPendingUpdates((prev) => {
      const next = new Map(prev);
      const docMap = new Map(next.get(documentIdx) ?? []);
      docMap.set(arrayIdx, newColor);
      next.set(documentIdx, docMap);
      return next;
    });

    const existing = inflightDocs.get(documentIdx);
    inflightDocs.set(documentIdx, {
      time: existing?.time ?? performance.now(),
      count: (existing?.count ?? 0) + 1,
    });
    setPendingToggleCount((c) => c + 1);

    conn.reducers.toggle({ documentIdx, arrayIdx, color: newColor });
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100vh",
        width: "100vw",
        "box-sizing": "border-box",
        overflow: "hidden",
        "font-family": "system-ui, sans-serif",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          padding: "8px 12px",
          "border-bottom": "1px solid #e5e7eb",
          background: "#fff",
          "flex-shrink": "0",
          gap: "12px",
          "flex-wrap": "wrap",
        }}
      >
        <div>
          <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
            <span style={{ "font-weight": "700", "font-size": "1rem" }}>
              One Billion Checkboxes
            </span>
            <Show when={isSyncing()}>
              <span
                aria-label="Connecting…"
                style={{
                  display: "inline-block",
                  width: "10px",
                  height: "10px",
                  border: "2px solid #e5e7eb",
                  "border-top-color": "#6b7280",
                  "border-radius": "50%",
                  animation: "spin 0.75s linear infinite",
                  "flex-shrink": "0",
                }}
              />
            </Show>
            {/* Toggle round-trip indicator */}
            <span
              style={{
                display: "inline-flex",
                "align-items": "center",
                "justify-content": "center",
                "min-width": "38px",
                "font-size": "0.7rem",
                "font-variant-numeric": "tabular-nums",
                opacity:
                  !isSyncing() &&
                  (pendingToggleCount() > 0 || lastRoundTripMs() !== null)
                    ? "1"
                    : "0",
                transition: "opacity 0.2s ease-out",
              }}
            >
              <Show
                when={pendingToggleCount() > 0}
                fallback={
                  <span style={{ color: "#16a34a" }}>
                    {lastRoundTripMs()}ms
                  </span>
                }
              >
                <span
                  style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    border: "1.5px solid #e5e7eb",
                    "border-top-color": "#9ca3af",
                    "border-radius": "50%",
                    animation: "spin 0.6s linear infinite",
                  }}
                />
              </Show>
            </span>
          </div>
          <div
            style={{
              color: "#6b7280",
              "font-size": "0.8rem",
              "margin-top": "2px",
            }}
          >
            {isSyncing()
              ? "Connecting…"
              : `${numCheckedBoxes().toLocaleString()} colored`}
          </div>
        </div>

        {/* Color palette */}
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "6px",
            "flex-wrap": "wrap",
          }}
        >
          <span style={{ "font-size": "0.75rem", color: "#9ca3af" }}>
            Color:
          </span>
          <div style={{ display: "flex", gap: "3px", "flex-wrap": "wrap" }}>
            <For each={PALETTE} keyed={false}>
              {(colorAccessor, i) => (
                <button
                  onClick={(e) => {
                    setSelectedColor(i());
                  }}
                  title={i() === 0 ? "Clear (uncheck)" : `Color ${i()}`}
                  style={{
                    width: "20px",
                    height: "20px",
                    "background-color": i() === 0 ? "#fff" : colorAccessor(),
                    border:
                      selectedColor() === i()
                        ? "2px solid #1f2937"
                        : "1px solid #d1d5db",
                    "border-radius": "3px",
                    cursor: "pointer",
                    padding: "0",
                    "font-size": "9px",
                    color: "#374151",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    "flex-shrink": "0",
                  }}
                >
                  {i() === 0 ? "✕" : ""}
                </button>
              )}
            </For>
          </div>
        </div>

        <div
          style={{
            "font-size": "0.75rem",
            color: "#9ca3af",
            "text-align": "right",
          }}
        >
          <a
            style={{ "text-decoration": "none", color: "#6b7280" }}
            href="https://spacetimedb.com/?referral=gillkyle"
            target="_blank"
          >
            Powered by SpacetimeDB
          </a>
        </div>
      </div>

      {/* ── Grid container (measured by ResizeObserver) ── */}
      <div
        ref={containerRef}
        style={{ "flex-grow": "1", overflow: "hidden", position: "relative" }}
      >
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Loading
          {...({ on: gridReady } as any)}
          fallback={
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                "align-items": "center",
                "justify-content": "center",
                height: "100%",
                gap: "10px",
                color: "#9ca3af",
                "font-family": "system-ui, sans-serif",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: "28px",
                  height: "28px",
                  border: "3px solid #e5e7eb",
                  "border-top-color": "#6b7280",
                  "border-radius": "50%",
                  animation: "spin 0.75s linear infinite",
                }}
              />
              <span style={{ "font-size": "0.875rem" }}>
                {isConnected()
                  ? "Loading checkboxes…"
                  : "Connecting to SpacetimeDB…"}
              </span>
            </div>
          }
        >
          <Show when={gridReady()}>
            {/* Scroll container with spacer for native scrollbar */}
            <div
              ref={(el: HTMLDivElement) => {
                scrollRef = el;
                requestAnimationFrame(() => {
                  setScrollbarWidth(el.offsetWidth - el.clientWidth);
                });
              }}
              style={{ width: "100%", height: "100%", overflow: "auto" }}
              onScroll={onScroll}
            >
              {/* Spacer sets the full virtual height for scrollbar sizing */}
              <div
                style={{
                  height: `${totalHeight()}px`,
                  width: `${numColumns() * CELL_SIZE}px`,
                  position: "relative",
                  margin: "0 auto",
                }}
              >
                {/*
                Fixed pool of DOM elements positioned via translateY.
                On scroll, startRow changes → each cell's index updates →
                SolidJS only touches DOM nodes whose color actually changed.
              */}
                <div
                  style={{
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    transform: `translateY(${startRow() * CELL_SIZE}px)`,
                    "will-change": "transform",
                  }}
                >
                  <For each={rowPool()} keyed={false}>
                    {(localRow) => {
                      const rowIdx = () => startRow() + localRow();
                      return (
                        <div
                          style={{ display: "flex", height: `${CELL_SIZE}px` }}
                        >
                          <For each={colPool()} keyed={false}>
                            {(col) => {
                              const globalIndex = () =>
                                rowIdx() * numColumns() + col();
                              const documentIdx = () =>
                                globalIndex() % NUM_DOCUMENTS;
                              const arrayIdx = () =>
                                Math.floor(globalIndex() / NUM_DOCUMENTS);
                              const colorVal = () => {
                                if (globalIndex() >= NUM_BOXES) return -1; // out of range
                                return getCellColor(documentIdx(), arrayIdx());
                              };
                              const isColored = () => colorVal() > 0;
                              const isVisible = () => colorVal() >= 0;

                              return (
                                <div
                                  style={{
                                    width: `${CELL_SIZE}px`,
                                    height: `${CELL_SIZE}px`,
                                    padding: "1px",
                                    visibility: isVisible()
                                      ? "visible"
                                      : "hidden",
                                  }}
                                >
                                  <div
                                    class={
                                      isColored() ? "cell cell-filled" : "cell"
                                    }
                                    onClick={() => {
                                      if (!isVisible() || loading()) return;
                                      toggle(documentIdx(), arrayIdx());
                                    }}
                                    style={{
                                      width: `${CELL_SIZE - 2}px`,
                                      height: `${CELL_SIZE - 2}px`,
                                      "background-color": isColored()
                                        ? PALETTE[colorVal()]
                                        : "#fff",
                                      border: `1px solid ${isColored() ? PALETTE[colorVal()] : "#e5e7eb"}`,
                                      cursor: loading() ? "default" : "pointer",
                                      color: "#fff",
                                    }}
                                  >
                                    {isColored() ? "✓" : ""}
                                  </div>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>
          </Show>
        </Loading>
      </div>
    </div>
  );
}
