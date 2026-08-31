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
  action,
  createSignal,
  createOptimistic,
  createOptimisticStore,
  createStore,
  createMemo,
  createEffect,
  isPending,
  onSettled,
  For,
  Show,
  Loading,
} from "solid-js";
import "./app.css";
import { conn, isConnected } from "./main.tsx";
import type { EventContext } from "./module_bindings/index.ts";
import type { Checkboxes, CheckboxChanges, Stats } from "./module_bindings/types.ts";
import { checkboxRangeStream, type CheckboxDocRange, type CheckboxRangePhase } from "./lib/checkbox-stream.ts";
import { createCheckboxStateController, type InflightCell } from "./lib/checkbox-state.ts";
import { buildCellSprites, paintGrid, type CellSprites } from "./lib/grid-canvas.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_BOXES = 1_000_000_000;
const NUM_DOCUMENTS = 250_000;
const CELL_SIZE = 22; // px
const OVERSCAN = 3; // extra rows above/below viewport
const MAX_SCROLL_HEIGHT = 32_000_000; // px — comfortably under Chrome's practical ceiling
const SUBSCRIPTION_BUFFER_VIEWPORTS = 3; // subscribe beyond the viewport for smoother fast scrolling

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

function getColor(boxes: ArrayLike<number>, arrayIdx: number): number {
  const byte = boxes[Math.floor(arrayIdx / 2)] || 0;
  return arrayIdx % 2 === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  // ── Data state ──────────────────────────────────────────────────────────
  const [boxesStore, setBoxesStore] = createStore<Record<number, Uint8Array>>({});
  // Raw Uint8Array data parallel to boxesStore. SolidJS wraps store values in
  // Proxies which break TypedArray operations (new Uint8Array(proxy),
  // Uint8Array.from(proxy), proxy.slice(), etc.). Mutations read from rawBoxes
  // to avoid Proxy issues; boxesStore is used only for rendering reactivity.
  const rawBoxes: Record<number, Uint8Array> = {};

  const [totalColored, setTotalColored] = createSignal(0n);
  const [pendingCountDelta, setPendingCountDelta] = createOptimistic(0);
  const [statsReady, setStatsReady] = createSignal(false);

  // ── Async subscription + grid readiness ──────────────────────────────
  let resolveSubscription!: () => void;
  let subscriptionResolved = false;
  const subscriptionPromise = new Promise<void>((res) => {
    resolveSubscription = res;
  });

  const [containerMeasured, setContainerMeasured] = createSignal(false);
  const [syncPhase, setSyncPhase] = createSignal<CheckboxRangePhase>("syncing");
  const [activeRange, setActiveRange] = createSignal<CheckboxDocRange | null>(null);

  const gridReady = createMemo(async () => {
    await subscriptionPromise;
    return true as const;
  });

  const isSyncing = () => syncPhase() !== "live" || isPending(() => gridReady());

  // ── Viewport-scoped subscription ────────────────────────────────────
  let subDebounceTimer = 0;

  // ── Pending optimistic writes ─────────────────────────────────────────
  const [pendingStore, setPendingStore] = createOptimisticStore<Record<number, Record<number, number>>>({});

  // ── Round-trip timing ─────────────────────────────────────────────────
  // Keyed by "docIdx:arrayIdx" so foreign change events (other users clicking
  // a different cell in the same document) don't steal our inflight counts.
  const inflightCells = new Map<string, InflightCell>();
  const [pendingToggleCount, setPendingToggleCount] = createSignal(0);
  const [lastRoundTripMs, setLastRoundTripMs] = createSignal<number | null>(
    null,
  );
  let inflightGcTimer = 0;

  // Bumped whenever painted board data changes, so the canvas renderer knows to
  // repaint without subscribing to every cell in the store.
  const [dataVersion, setDataVersion] = createSignal(0);
  const bumpDataVersion = () => setDataVersion(v => v + 1);

  const checkboxState = createCheckboxStateController({
    rawBoxes,
    pendingStore,
    setBoxesStore,
    setPendingStore,
    inflightCells,
    setPendingToggleCount,
    setLastRoundTripMs,
    setTotalColored,
    setPendingCountDelta,
    onChange: bumpDataVersion,
  });

  const rangeContainsDoc = (range: CheckboxDocRange, docIdx: number) =>
    range.wraps
      ? docIdx >= range.min || docIdx <= range.max
      : docIdx >= range.min && docIdx <= range.max;

  const applyRangeSnapshot = (range: CheckboxDocRange) => {
    const seen = new Set<number>();

    for (const row of conn.db.checkboxes.iter()) {
      if (!rangeContainsDoc(range, row.idx)) continue;
      seen.add(row.idx);
      checkboxState.upsertRow(row);
    }

    for (const key of Object.keys(rawBoxes)) {
      const docIdx = Number(key);
      if (!rangeContainsDoc(range, docIdx) || seen.has(docIdx)) continue;
      delete rawBoxes[docIdx];
      setBoxesStore(s => {
        delete s[docIdx];
      });
      setPendingStore(s => {
        delete s[docIdx];
      });
    }

    bumpDataVersion();
  };

  /** Periodically clear stale inflight cells (safety net for missed events). */
  const INFLIGHT_STALE_MS = 8000;
  const gcInflightCells = () => {
    const now = performance.now();
    for (const [key, inflight] of [...inflightCells]) {
      if (now - inflight.time > INFLIGHT_STALE_MS) {
        const sep = key.indexOf(":");
        checkboxState.dropInflight(
          Number(key.slice(0, sep)),
          Number(key.slice(sep + 1)),
        );
      }
    }
    inflightGcTimer = inflightCells.size > 0
      ? window.setTimeout(gcInflightCells, 2000)
      : 0;
  };

  // ── Client-side rate limiting (matches server: 20 toggles/sec) ───────
  const RATE_LIMIT_WINDOW = 1000; // ms
  const RATE_LIMIT_MAX = 20;
  let rateLimitStart = 0;
  let rateLimitCount = 0;

  const [rateLimited, setRateLimited] = createSignal(false);
  let rateLimitFadeTimer = 0;

  // ── UI state ──────────────────────────────────────────────────────────
  const [selectedColor, setSelectedColor] = createSignal(1);
  const [colsInputFocused, setColsInputFocused] = createSignal(false);

  // ── Virtual scroll state ──────────────────────────────────────────────
  let containerRef!: HTMLDivElement;
  let scrollRef!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = createSignal(0);

  // ── Offset & columns (URL ↔ input ↔ scroll) ─────────────────────────
  const urlParams = new URLSearchParams(window.location.search);
  const initialOffset = (() => {
    const p = urlParams.get("offset");
    const n = p ? parseInt(p, 10) : NaN;
    return Number.isFinite(n) && n >= 0 && n < NUM_BOXES ? n : 0;
  })();
  const initialCols = (() => {
    const p = urlParams.get("cols");
    const n = p ? parseInt(p, 10) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : null;
  })();
  const [currentOffset, setCurrentOffset] = createSignal(initialOffset);
  const [customCols, setCustomCols] = createSignal<number | null>(initialCols);
  // When true, the scroll handler won't update currentOffset (prevents loop)
  let scrollFromInput = false;

  /** Scroll the grid to a global checkbox index. Returns the actual offset
   *  after the browser clamps scrollTop (e.g. near the bottom). */
  const scrollToOffset = (offset: number): number => {
    if (!scrollRef) return offset;
    const cols = numColumns();
    if (cols <= 0) return offset;
    const row = Math.floor(offset / cols);
    scrollFromInput = true;
    // Divide by scrollScale to convert logical pixel position to physical
    scrollRef.scrollTop = (row * CELL_SIZE) / scrollScale();
    setScrollTop(scrollRef.scrollTop);
    // Read back the actual position (browser clamps scrollTop at the bottom)
    const actualRow = Math.floor((scrollRef.scrollTop * scrollScale()) / CELL_SIZE);
    const actualOffset = Math.min(actualRow * cols, NUM_BOXES - 1);
    setCurrentOffset(actualOffset);
    requestAnimationFrame(() => { scrollFromInput = false; });
    return actualOffset;
  };

  /** Sync offset + cols → URL query params. */
  const syncToUrl = (offset: number) => {
    const url = new URL(window.location.href);
    if (offset > 0) {
      url.searchParams.set("offset", String(offset));
    } else {
      url.searchParams.delete("offset");
    }
    const cols = customCols();
    if (cols !== null) {
      url.searchParams.set("cols", String(cols));
    } else {
      url.searchParams.delete("cols");
    }
    history.replaceState(null, "", url);
  };

  // ── One-time setup after mount ────────────────────────────────────────
  let rafId = 0;
  let urlUpdateTimer = 0;

  onSettled(() => {
    const obs = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) {
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
        if (!containerMeasured()) setContainerMeasured(true);
        // Recalculate offset for new column count after resize
        if (scrollRef && !scrollFromInput) {
          // Measured here rather than in the scroll handler: reading offsetWidth
          // forces layout, and the scrollbar cannot change width mid-scroll.
          setScrollbarWidth(scrollRef.offsetWidth - scrollRef.clientWidth);
          const cols = Math.max(1, Math.floor((e.contentRect.width - scrollbarWidth()) / CELL_SIZE));
          const topRow = Math.floor((scrollRef.scrollTop * scrollScale()) / CELL_SIZE);
          setCurrentOffset(Math.min(topRow * cols, NUM_BOXES - 1));
        }
      }
    });
    obs.observe(containerRef);

    const disposeObserver = () => {
      obs.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(subDebounceTimer);
      clearTimeout(inflightGcTimer);
      clearTimeout(urlUpdateTimer);
      checkboxState.cleanup();
    };

    const handleCheckboxInsert = (_ctx: EventContext, row: Checkboxes) => {
      checkboxState.upsertRow(row);
    };
    const handleCheckboxUpdate = (_ctx: EventContext, _old: Checkboxes, row: Checkboxes) => {
      checkboxState.upsertRow(row);
    };
    const handleCheckboxDelete = (_ctx: EventContext, _row: Checkboxes) => {};

    conn.db.checkboxes.onInsert(handleCheckboxInsert);
    conn.db.checkboxes.onUpdate(handleCheckboxUpdate);

    // When unsubscribing from full docs (Phase 2), SpacetimeDB fires onDelete
    // for every row leaving the subscription. We keep boxesStore intact —
    // change events will keep it current. Memory cost is trivial (~2KB/doc).
    conn.db.checkboxes.onDelete(handleCheckboxDelete);

    // SpacetimeDB event handlers — lightweight change events
    const handleCheckboxChangeInsert = (_ctx: EventContext, change: CheckboxChanges) => {
      checkboxState.applyChange(change);
    };
    const handleCheckboxChangeDelete = (_ctx: EventContext, _change: CheckboxChanges) => {};

    conn.db.checkboxChanges.onInsert(handleCheckboxChangeInsert);

    // Pruned change events — no action needed
    conn.db.checkboxChanges.onDelete(handleCheckboxChangeDelete);

    // SpacetimeDB event handlers — stats (global colored count)
    const handleStatsInsert = (_ctx: EventContext, row: Stats) => checkboxState.upsertStats(row);
    const handleStatsUpdate = (_ctx: EventContext, _old: Stats, row: Stats) => checkboxState.upsertStats(row);

    conn.db.stats.onInsert(handleStatsInsert);
    conn.db.stats.onUpdate(handleStatsUpdate);

    // Permanent subscription to stats (tiny — single row)
    const statsHandle = conn.subscriptionBuilder()
      .onApplied(() => setStatsReady(true))
      .subscribe("SELECT * FROM stats");

    // onSettled takes a returned cleanup function; calling onCleanup inside it
    // is a hard error in Solid 2.x (CLEANUP_IN_FORBIDDEN_SCOPE), and the throw
    // halts the whole reactive system.
    return () => {
      disposeObserver();
      conn.db.checkboxes.removeOnInsert(handleCheckboxInsert);
      conn.db.checkboxes.removeOnUpdate(handleCheckboxUpdate);
      conn.db.checkboxes.removeOnDelete(handleCheckboxDelete);
      conn.db.checkboxChanges.removeOnInsert(handleCheckboxChangeInsert);
      conn.db.checkboxChanges.removeOnDelete(handleCheckboxChangeDelete);
      conn.db.stats.removeOnInsert(handleStatsInsert);
      conn.db.stats.removeOnUpdate(handleStatsUpdate);
      try {
        if (!statsHandle.isEnded()) statsHandle.unsubscribe();
      } catch {}
    };
  });

  // ── Derived scroll values ─────────────────────────────────────────────
  const [scrollbarWidth, setScrollbarWidth] = createSignal(0);
  const autoColumns = () =>
    Math.max(1, Math.floor((size().width - scrollbarWidth()) / CELL_SIZE));
  const numColumns = () => customCols() ?? autoColumns();
  const numRows = () => Math.ceil(NUM_BOXES / numColumns());
  // Logical height of all rows + one extra CELL_SIZE so the last row isn't clipped
  const logicalHeight = () => numRows() * CELL_SIZE + CELL_SIZE;
  // Browsers cap scrollable height (~33M px Chrome, ~17M Firefox). Cap the
  // spacer at a safe maximum and scale scroll position proportionally.
  const spacerHeight = () => Math.min(logicalHeight(), MAX_SCROLL_HEIGHT);
  const scrollScale = () => logicalHeight() / spacerHeight();

  // The first visible row (with overscan above), clamped at both ends
  // so the pool never overshoots numRows at the bottom.
  const startRow = () => {
    const raw = Math.floor((scrollTop() * scrollScale()) / CELL_SIZE) - OVERSCAN;
    const maxStart = Math.max(0, numRows() - poolRows());
    return Math.max(0, Math.min(raw, maxStart));
  };

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

  // ── Viewport-scoped subscription management ──────────────────────────

  /** Compute the document index range visible on screen (with buffer). */
  const visibleDocRange = () => {
    if (!containerMeasured()) return null;
    const cols = numColumns();
    if (cols <= 0) return null;

    const visibleRows = poolRows();
    const bufferRows = visibleRows * SUBSCRIPTION_BUFFER_VIEWPORTS;
    const firstRow = Math.max(0, startRow() - bufferRows);
    const lastRow = Math.min(numRows() - 1, startRow() + visibleRows + bufferRows);

    const firstGlobal = firstRow * cols;
    const lastGlobal = Math.min(lastRow * cols + cols - 1, NUM_BOXES - 1);

    const span = lastGlobal - firstGlobal + 1;
    if (span >= NUM_DOCUMENTS) {
      return { min: 0, max: NUM_DOCUMENTS - 1, wraps: false };
    }

    const minDoc = firstGlobal % NUM_DOCUMENTS;
    const maxDoc = lastGlobal % NUM_DOCUMENTS;
    return { min: minDoc, max: maxDoc, wraps: maxDoc < minDoc };
  };

  /** Check if a doc index falls within the currently active range. */
  const isInActiveRange = (docIdx: number) => {
    const range = activeRange();
    if (!range) return false;
    if (range.max < range.min) {
      // wraps around
      return docIdx >= range.min || docIdx <= range.max;
    }
    return docIdx >= range.min && docIdx <= range.max;
  };

  // Reset subscription state on disconnect so reconnect triggers a fresh
  // bootstrap for the next visible range.
  createEffect(
    () => isConnected(),
    (connected) => {
      if (!connected) {
        setActiveRange(null);
        setSyncPhase("syncing");
      }
    },
  );

  /** Effect: watch visible range and connection state, update subscription. */
  createEffect(
    () => ({ range: visibleDocRange(), connected: isConnected() }),
    ({ range, connected }) => {
      if (!range || !connected) return;

      const current = activeRange();

      // First subscription or reconnect — immediate
      if (!current) {
        setActiveRange(range);
        return;
      }

      // Only resubscribe if visible edge has moved outside active range
      if (isInActiveRange(range.min) && isInActiveRange(range.max)) {
        return;
      }

      // Debounce to avoid thrashing during fast scroll
      clearTimeout(subDebounceTimer);
      subDebounceTimer = window.setTimeout(() => {
        const fresh = visibleDocRange();
        if (fresh) setActiveRange(fresh);
      }, 200);
    },
  );

  createEffect(
    () => ({ range: activeRange(), connected: isConnected() }),
    ({ range, connected }) => {
      if (!range || !connected) return;

      const abortController = new AbortController();

      void (async () => {
        try {
          for await (const event of checkboxRangeStream({
            conn,
            range,
            signal: abortController.signal,
          })) {
            switch (event.kind) {
              case "phase":
                setSyncPhase(event.phase);
                break;
              case "snapshot-ready":
                applyRangeSnapshot(event.range);
                if (!subscriptionResolved) {
                  subscriptionResolved = true;
                  resolveSubscription();
                }
                break;
            }
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            console.error("Checkbox range stream failed:", error);
          }
        }
      })();

      return () => {
        abortController.abort();
      };
    },
  );

  // ── Side effects ──────────────────────────────────────────────────────

  createEffect(
    () => Number(totalColored()) + pendingCountDelta(),
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

      // Scroll → offset + URL (skip if this scroll was triggered by input)
      if (!scrollFromInput) {
        const cols = numColumns();
        const topRow = Math.floor((scrollRef.scrollTop * scrollScale()) / CELL_SIZE);
        const offset = Math.min(topRow * cols, NUM_BOXES - 1);
        setCurrentOffset(offset);

        clearTimeout(urlUpdateTimer);
        urlUpdateTimer = window.setTimeout(() => syncToUrl(offset), 300);
      }
    });
  };

  // ── Toggle handler ────────────────────────────────────────────────────
  const loading = () => !isConnected() || !gridReady();

  /** Look up effective color for a cell (pending overlay first, then base). */
  const getCellColor = (documentIdx: number, arrayIdx: number): number => {
    const docPending = pendingStore[documentIdx];
    if (docPending && arrayIdx in docPending) return docPending[arrayIdx];
    const docBoxes = boxesStore[documentIdx];
    return docBoxes ? getColor(docBoxes, arrayIdx) : 0;
  };

  const toggle = (documentIdx: number, arrayIdx: number) => {
    if (loading()) return;

    // Client-side rate limit — drop excess clicks before they hit the server
    const now = performance.now();
    if (now - rateLimitStart > RATE_LIMIT_WINDOW) {
      rateLimitStart = now;
      rateLimitCount = 0;
    }
    if (++rateLimitCount > RATE_LIMIT_MAX) {
      setRateLimited(true);
      clearTimeout(rateLimitFadeTimer);
      rateLimitFadeTimer = window.setTimeout(() => setRateLimited(false), 2000);
      return;
    }

    const currentColor = getCellColor(documentIdx, arrayIdx);
    const newColor =
      currentColor === selectedColor() && selectedColor() !== 0
        ? 0
        : selectedColor();

    // A toggle that does not change the cell produces no server-side change and
    // therefore no change event to confirm it — it would sit in `inflightCells`
    // until the stale sweep, showing a phantom pending toggle and burning a
    // rate-limit slot. Nothing to do, so do nothing.
    if (newColor === currentColor) return;

    setPendingStore(s => {
      if (!s[documentIdx]) s[documentIdx] = {};
      s[documentIdx][arrayIdx] = newColor;
    });

    // Optimistic count adjustment, tracked per cell so it can be reverted
    // exactly if the toggle is dropped or rejected.
    const delta = (newColor > 0 ? 1 : 0) - (currentColor > 0 ? 1 : 0);
    checkboxState.noteToggle(documentIdx, arrayIdx, newColor, delta);
    if (!inflightGcTimer) inflightGcTimer = window.setTimeout(gcInflightCells, 2000);

    void submitToggle({ documentIdx, arrayIdx, color: newColor });
  };

  const submitToggle = action(async function* (payload: {
    documentIdx: number;
    arrayIdx: number;
    color: number;
  }) {
    const { documentIdx, arrayIdx, color } = payload;
    try {
      await conn.reducers.toggle({ documentIdx, arrayIdx, color });
      yield;
    } catch {
      // Roll the cell's optimistic state back as a unit — overlay, pending
      // counter and count delta together. Any toggle for this cell that did
      // land is re-counted when its change event arrives.
      checkboxState.dropInflight(documentIdx, arrayIdx);
      setRateLimited(true);
      clearTimeout(rateLimitFadeTimer);
      rateLimitFadeTimer = window.setTimeout(() => setRateLimited(false), 2000);
    }
  });

  // ── Canvas renderer ──────────────────────────────────────────────────
  // Painting the pool as sprites costs a few thousand blits with no layout or
  // style recalc, where the DOM pool costs a class/style write per cell plus a
  // full recalc — every time startRow moves, which during a scroll is nearly
  // every frame. The DOM renderer stays as the fallback.
  let gridCanvas: HTMLCanvasElement | undefined;
  const [canvasSprites, setCanvasSprites] = createSignal<CellSprites | null>(null);
  const [canvasFailed, setCanvasFailed] = createSignal(false);

  const useCanvas = () =>
    urlParams.get("renderer") !== "dom" && !canvasFailed();

  const devicePixelRatioValue = () => window.devicePixelRatio || 1;

  createEffect(
    () => ({ enabled: useCanvas(), dpr: devicePixelRatioValue() }),
    ({ enabled, dpr }) => {
      if (!enabled) return;
      const sprites = buildCellSprites(PALETTE, CELL_SIZE, dpr);
      if (!sprites) {
        setCanvasFailed(true);
        return;
      }
      setCanvasSprites(sprites);
    },
  );

  createEffect(
    () => ({
      sprites: canvasSprites(),
      start: startRow(),
      rows: poolRows(),
      cols: numColumns(),
      totalRows: numRows(),
      // Tracked so board updates repaint; the values themselves are read
      // untracked inside getCellColor.
      version: dataVersion(),
      ready: !loading(),
    }),
    ({ sprites, start, rows, cols, totalRows }) => {
      const canvas = gridCanvas;
      if (!canvas || !sprites) return;

      const { dpr } = sprites;
      const width = cols * CELL_SIZE;
      const height = rows * CELL_SIZE;
      const backingWidth = Math.round(width * dpr);
      const backingHeight = Math.round(height * dpr);

      // Resizing the backing store also clears it, so only touch it on change.
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setCanvasFailed(true);
        return;
      }

      paintGrid({
        ctx,
        sprites,
        startRow: start,
        rows,
        cols,
        totalRows,
        numBoxes: NUM_BOXES,
        numDocuments: NUM_DOCUMENTS,
        getCellColor,
      });
    },
  );

  /** Map a click on the canvas back to a checkbox and toggle it. */
  const onCanvasClick = (e: MouseEvent) => {
    if (loading()) return;
    const canvas = gridCanvas;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / CELL_SIZE);
    const localRow = Math.floor((e.clientY - rect.top) / CELL_SIZE);
    const cols = numColumns();
    if (col < 0 || col >= cols || localRow < 0 || localRow >= poolRows()) return;

    const rowIdx = startRow() + localRow;
    if (rowIdx >= numRows()) return;

    const globalIndex = rowIdx * cols + col;
    if (globalIndex >= NUM_BOXES) return;

    toggle(globalIndex % NUM_DOCUMENTS, Math.floor(globalIndex / NUM_DOCUMENTS));
  };


  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div class="app-root">
      {/* ── Header ── */}
      <div class="header">
        <div>
          <div class="title-row">
            <span class="title">One Billion Checkboxes</span>
            <Show when={isSyncing()}>
              <span
                aria-label="Connecting…"
                class="spinner spinner-sm"
              />
            </Show>
            {/* Toggle round-trip indicator */}
            <span
              class="round-trip"
              style={{
                opacity:
                  !isSyncing() &&
                  (pendingToggleCount() > 0 || lastRoundTripMs() !== null)
                    ? "1"
                    : "0",
              }}
            >
              <Show
                when={pendingToggleCount() > 0}
                fallback={
                  <span class="round-trip-ms">
                    {lastRoundTripMs()}ms
                  </span>
                }
              >
                <span class="spinner spinner-xs" />
              </Show>
            </span>
            <span
              class="rate-limited"
              style={{ opacity: rateLimited() ? "1" : "0" }}
            >
              Rate Limited
            </span>
          </div>
          <div class="subtitle">
            <span>
              {!statsReady()
                ? "Connecting…"
                : `${(Number(totalColored()) + pendingCountDelta()).toLocaleString()} colored`}
            </span>
            <Show when={statsReady()}>
              <span class="dot-separator">·</span>
              <span class="offset-group">
                <span class="offset-hash">#</span>
                <input
                  class="offset-input"
                  type="text"
                  inputmode="numeric"
                  value={currentOffset().toLocaleString()}
                  onFocus={(e) => {
                    e.currentTarget.value = String(currentOffset());
                    e.currentTarget.select();
                  }}
                  onBlur={(e) => {
                    e.currentTarget.value = currentOffset().toLocaleString();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const raw = e.currentTarget.value.replace(/[^0-9]/g, "");
                      const n = parseInt(raw, 10);
                      if (Number.isFinite(n) && n >= 0) {
                        const clamped = Math.min(n, NUM_BOXES - 1);
                        const actual = scrollToOffset(clamped);
                        syncToUrl(actual);
                      }
                      e.currentTarget.blur();
                    }
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                />
              </span>
              <span class="dot-separator">·</span>
              <span class="cols-group">
                <span class="offset-hash">cols</span>
                <input
                  class="offset-input cols-input"
                  type="text"
                  inputmode="numeric"
                  value={customCols() !== null ? String(customCols()) : ""}
                  onFocus={(e) => {
                    setColsInputFocused(true);
                    e.currentTarget.value = customCols() !== null ? String(customCols()) : "";
                    e.currentTarget.select();
                  }}
                  onBlur={(e) => {
                    setColsInputFocused(false);
                    e.currentTarget.value = customCols() !== null ? String(customCols()) : "";
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const raw = e.currentTarget.value.replace(/[^0-9]/g, "");
                      const offset = currentOffset();
                      if (raw === "") {
                        setCustomCols(null);
                      } else {
                        const n = parseInt(raw, 10);
                        if (Number.isFinite(n) && n >= 1) setCustomCols(n);
                      }
                      const actual = scrollToOffset(offset);
                      syncToUrl(actual);
                      e.currentTarget.blur();
                    }
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                />
                <span class="cols-hint" style={{ opacity: colsInputFocused() ? "1" : "0" }}>
                  Enter to submit
                </span>
              </span>
            </Show>
          </div>
        </div>

        {/* Color palette */}
        <div class="palette-section">
          <span class="palette-label">Color:</span>
          <div class="palette-row">
            <For each={PALETTE} keyed={false}>
              {(colorAccessor, i) => (
                <button
                  class={`palette-btn ${selectedColor() === i ? "palette-btn-selected" : "palette-btn-unselected"}`}
                  onClick={() => setSelectedColor(i)}
                  title={i === 0 ? "Clear (uncheck)" : `Color ${i}`}
                  style={{
                    "background-color": i === 0 ? "#fff" : colorAccessor(),
                  }}
                >
                  {i === 0 ? "✕" : ""}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="footer-links">
          <a href="/life" class="link-bold">Game of Life</a>
          {" · "}
          <a href="https://spacetimedb.com/?referral=gillkyle" target="_blank">
            Powered by SpacetimeDB
          </a>
          {" and "}
          <a href="https://github.com/solidjs/solid/discussions/2596" target="_blank">
            Solid 2.0
          </a>
          {" · "}
          <a href="https://github.com/doeixd/one-billion-checkboxes-spacetime" target="_blank">
            Repo
          </a>
        </div>
      </div>

      {/* ── Grid container (measured by ResizeObserver) ── */}
      <div ref={containerRef} class="grid-container">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Loading
          {...({ on: gridReady } as any)}
          fallback={
            <div class="loading-fallback">
              <span class="spinner spinner-lg" />
              <span>
                {isConnected()
                  ? "Loading checkboxes…"
                  : "Connecting to SpacetimeDB…"}
              </span>
            </div>
          }
        >
          <Show when={gridReady()}>
            <div
              ref={(el: HTMLDivElement) => {
                scrollRef = el;
                // Intercept wheel events to de-scale deltas so mouse/trackpad
                // scrolling stays smooth despite the compressed spacer.
                el.addEventListener('wheel', (e) => {
                  e.preventDefault();
                  let deltaY = e.deltaY;
                  if (e.deltaMode === 1) deltaY *= CELL_SIZE; // lines → px
                  else if (e.deltaMode === 2) deltaY *= size().height; // pages → px
                  el.scrollTop += deltaY / scrollScale();
                }, { passive: false });
                requestAnimationFrame(() => {
                  setScrollbarWidth(el.offsetWidth - el.clientWidth);
                  if (initialOffset > 0) scrollToOffset(initialOffset);
                });
              }}
              class="scroll-container"
              onScroll={onScroll}
            >
              <div
                class="virtual-spacer"
                style={{
                  height: `${spacerHeight()}px`,
                  width: `${numColumns() * CELL_SIZE}px`,
                }}
              >
                <div
                  class="row-pool"
                  style={{ transform: `translateY(${scrollTop() * (1 - scrollScale()) + startRow() * CELL_SIZE}px)` }}
                >
                  <Show
                    when={useCanvas()}
                    fallback={
                  <For each={rowPool()} keyed={false}>
                    {(localRow) => {
                      const rowIdx = () => startRow() + localRow();
                      return (
                        <div class="grid-row">
                          <For each={colPool()} keyed={false}>
                            {(col) => {
                              const globalIndex = () =>
                                rowIdx() * numColumns() + col();
                              const documentIdx = () =>
                                globalIndex() % NUM_DOCUMENTS;
                              const arrayIdx = () =>
                                Math.floor(globalIndex() / NUM_DOCUMENTS);
                              const colorVal = () => {
                                if (globalIndex() >= NUM_BOXES) return -1;
                                return getCellColor(documentIdx(), arrayIdx());
                              };
                              const isColored = () => colorVal() > 0;
                              const isVisible = () => colorVal() >= 0;

                              return (
                                <div
                                  class="cell-wrapper"
                                  style={{
                                    visibility: isVisible()
                                      ? "visible"
                                      : "hidden",
                                  }}
                                >
                                  <div
                                    class={`cell${isColored() ? " cell-filled" : ""}${loading() ? " cell-loading" : ""}`}
                                    onClick={() => {
                                      if (!isVisible() || loading()) return;
                                      toggle(documentIdx(), arrayIdx());
                                    }}
                                    style={isColored() ? { "--cell-color": PALETTE[colorVal()] } : undefined}
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
                    }
                  >
                    <canvas
                      ref={(el: HTMLCanvasElement) => { gridCanvas = el; }}
                      class={`grid-canvas${loading() ? " grid-canvas-loading" : ""}`}
                      onClick={onCanvasClick}
                    />
                  </Show>
                </div>
              </div>
            </div>
          </Show>
        </Loading>
      </div>
    </div>
  );
}
