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
  createStore,
  createMemo,
  createEffect,
  isPending,
  onSettled,
  onCleanup,
  For,
  Show,
  Loading,
} from "solid-js";
import "./app.css";
import { conn, isConnected } from "./main.tsx";
import type { EventContext } from "./module_bindings/index.ts";
import type { SubscriptionHandle } from "./module_bindings/index.ts";
import type { Checkboxes, CheckboxChanges, Stats } from "./module_bindings/types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_BOXES = 1_000_000_000;
const NUM_DOCUMENTS = 250_000;
const CELL_SIZE = 22; // px
const OVERSCAN = 3; // extra rows above/below viewport
const MAX_SCROLL_HEIGHT = 32_000_000; // px — under Chrome's ~33.5M cap

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

/** Apply a nibble change to a byte array in-place. */
function setColorLocal(boxes: Uint8Array, arrayIdx: number, color: number): void {
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  boxes[byteIdx] = arrayIdx % 2 === 0
    ? (byte & 0xf0) | (color & 0x0f)
    : (byte & 0x0f) | ((color & 0x0f) << 4);
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
  const [pendingCountDelta, setPendingCountDelta] = createSignal(0);
  const [statsReady, setStatsReady] = createSignal(false);

  // ── Async subscription + grid readiness ──────────────────────────────
  let resolveSubscription!: () => void;
  let subscriptionResolved = false;
  const subscriptionPromise = new Promise<void>((res) => {
    resolveSubscription = res;
  });

  const [containerMeasured, setContainerMeasured] = createSignal(false);

  const gridReady = createMemo(async () => {
    await subscriptionPromise;
    return true as const;
  });

  const isSyncing = () => isPending(() => gridReady());

  // ── Viewport-scoped subscription ────────────────────────────────────
  let currentSubHandle: SubscriptionHandle | null = null;
  let subscribedMin = -1;
  let subscribedMax = -1;
  let subDebounceTimer = 0;
  let subGeneration = 0; // monotonic counter to detect stale callbacks

  // ── Pending optimistic writes ─────────────────────────────────────────
  const [pendingStore, setPendingStore] = createStore<Record<number, Record<number, number>>>({});

  // ── Round-trip timing ─────────────────────────────────────────────────
  // Keyed by "docIdx:arrayIdx" so foreign change events (other users clicking
  // a different cell in the same document) don't steal our inflight counts.
  const inflightCells = new Map<string, { time: number; count: number }>();
  const [pendingToggleCount, setPendingToggleCount] = createSignal(0);
  const [lastRoundTripMs, setLastRoundTripMs] = createSignal<number | null>(
    null,
  );
  let roundTripFadeTimer = 0;
  let inflightGcTimer = 0;

  /** Periodically clear stale inflight cells (safety net for missed events). */
  const INFLIGHT_STALE_MS = 8000;
  const gcInflightCells = () => {
    const now = performance.now();
    for (const [key, inflight] of inflightCells) {
      if (now - inflight.time > INFLIGHT_STALE_MS) {
        inflightCells.delete(key);
        setPendingToggleCount((c) => Math.max(0, c - inflight.count));
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

  // ── Virtual scroll state ──────────────────────────────────────────────
  let containerRef!: HTMLDivElement;
  let scrollRef!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = createSignal(0);

  // ── Offset (3-way: scroll ↔ input ↔ URL query param) ─────────────────
  const initialOffset = (() => {
    const p = new URLSearchParams(window.location.search).get("offset");
    const n = p ? parseInt(p, 10) : NaN;
    return Number.isFinite(n) && n >= 0 && n < NUM_BOXES ? n : 0;
  })();
  const [currentOffset, setCurrentOffset] = createSignal(initialOffset);
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

  /** Sync offset → URL query param. */
  const syncOffsetToUrl = (offset: number) => {
    const url = new URL(window.location.href);
    if (offset > 0) {
      url.searchParams.set("offset", String(offset));
    } else {
      url.searchParams.delete("offset");
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
          const cols = Math.max(1, Math.floor((e.contentRect.width - scrollbarWidth()) / CELL_SIZE));
          const topRow = Math.floor((scrollRef.scrollTop * scrollScale()) / CELL_SIZE);
          setCurrentOffset(Math.min(topRow * cols, NUM_BOXES - 1));
        }
      }
    });
    obs.observe(containerRef);

    onCleanup(() => {
      obs.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(roundTripFadeTimer);
      clearTimeout(subDebounceTimer);
      clearTimeout(inflightGcTimer);
      clearTimeout(urlUpdateTimer);
      if (currentSubHandle && !currentSubHandle.isEnded()) {
        currentSubHandle.unsubscribe();
      }
      if (phase1Handle && !phase1Handle.isEnded()) {
        phase1Handle.unsubscribe();
      }
    });

    // SpacetimeDB event handlers — checkboxes (full doc updates during Phase 1).
    // Change event handlers resolve per-cell first; this is the fallback that
    // catches anything remaining (e.g., if change events haven't arrived yet).
    const upsertRow = (row: Checkboxes) => {
      rawBoxes[row.idx] = row.boxes;
      setBoxesStore(s => { s[row.idx] = row.boxes; });

      // Fallback: clear any remaining pending entries for this document
      if (pendingStore[row.idx]) {
        setPendingStore(s => { delete s[row.idx]; });
      }

      // Fallback: resolve any remaining inflight cells for this document
      const prefix = `${row.idx}:`;
      for (const [key, inflight] of inflightCells) {
        if (key.startsWith(prefix)) {
          inflightCells.delete(key);
          const ms = Math.round(performance.now() - inflight.time);
          setLastRoundTripMs(ms);
          setPendingToggleCount((c) => Math.max(0, c - inflight.count));
          clearTimeout(roundTripFadeTimer);
          roundTripFadeTimer = window.setTimeout(
            () => setLastRoundTripMs(null),
            2000,
          );
        }
      }
    };

    conn.db.checkboxes.onInsert((_ctx: EventContext, row: Checkboxes) =>
      upsertRow(row),
    );
    conn.db.checkboxes.onUpdate(
      (_ctx: EventContext, _old: Checkboxes, row: Checkboxes) => upsertRow(row),
    );

    // When unsubscribing from full docs (Phase 2), SpacetimeDB fires onDelete
    // for every row leaving the subscription. We keep boxesStore intact —
    // change events will keep it current. Memory cost is trivial (~2KB/doc).
    conn.db.checkboxes.onDelete((_ctx: EventContext, _row: Checkboxes) => {});

    // SpacetimeDB event handlers — lightweight change events
    conn.db.checkboxChanges.onInsert((_ctx: EventContext, change: CheckboxChanges) => {
      const { documentIdx, arrayIdx, color } = change;
      // Apply nibble delta to the raw (non-Proxy) Uint8Array, then sync
      // a fresh copy to the SolidJS store for reactivity.
      const existing = rawBoxes[documentIdx];
      if (existing) {
        setColorLocal(existing, arrayIdx, color);
        setBoxesStore(s => { s[documentIdx] = new Uint8Array(existing); });
      } else {
        // Document was lazily created by this toggle — not in boxesStore yet
        const boxes = new Uint8Array(2000);
        setColorLocal(boxes, arrayIdx, color);
        rawBoxes[documentIdx] = boxes;
        setBoxesStore(s => { s[documentIdx] = new Uint8Array(boxes); });
      }

      // Clear pending overlay for this specific cell
      if (pendingStore[documentIdx]?.[arrayIdx] !== undefined) {
        setPendingStore(s => {
          if (s[documentIdx]) {
            delete s[documentIdx][arrayIdx];
            if (Object.keys(s[documentIdx]).length === 0) {
              delete s[documentIdx];
            }
          }
        });
      }

      // Resolve inflight timing — keyed per-cell so foreign users' change
      // events on the same document don't steal our inflight counts.
      const cellKey = `${documentIdx}:${arrayIdx}`;
      const inflight = inflightCells.get(cellKey);
      if (inflight) {
        const newCount = inflight.count - 1;
        if (newCount <= 0) {
          inflightCells.delete(cellKey);
          const ms = Math.round(performance.now() - inflight.time);
          setLastRoundTripMs(ms);
          setPendingToggleCount((c) => Math.max(0, c - 1));
          clearTimeout(roundTripFadeTimer);
          roundTripFadeTimer = window.setTimeout(() => setLastRoundTripMs(null), 2000);
        } else {
          inflightCells.set(cellKey, { ...inflight, count: newCount });
          setPendingToggleCount((c) => Math.max(0, c - 1));
        }
      }
    });

    // Pruned change events — no action needed
    conn.db.checkboxChanges.onDelete((_ctx: EventContext, _change: CheckboxChanges) => {});

    // SpacetimeDB event handlers — stats (global colored count)
    const upsertStats = (row: Stats) => {
      setTotalColored(row.totalColored);
      setPendingCountDelta(0); // server ground truth resets optimistic delta
    };
    conn.db.stats.onInsert((_ctx: EventContext, row: Stats) => upsertStats(row));
    conn.db.stats.onUpdate((_ctx: EventContext, _old: Stats, row: Stats) => upsertStats(row));

    // Permanent subscription to stats (tiny — single row)
    conn.subscriptionBuilder()
      .onApplied(() => setStatsReady(true))
      .subscribe("SELECT * FROM stats");
  });

  // ── Derived scroll values ─────────────────────────────────────────────
  const [scrollbarWidth, setScrollbarWidth] = createSignal(0);
  const numColumns = () =>
    Math.max(1, Math.floor((size().width - scrollbarWidth()) / CELL_SIZE));
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
    const bufferRows = visibleRows * 2; // 2x viewport buffer
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

  /** Check if a doc index falls within the currently subscribed range. */
  const isInSubscribedRange = (docIdx: number) => {
    if (subscribedMin === -1) return false;
    if (subscribedMax < subscribedMin) {
      // wraps around
      return docIdx >= subscribedMin || docIdx <= subscribedMax;
    }
    return docIdx >= subscribedMin && docIdx <= subscribedMax;
  };

  /** Build change-event-only queries for a document range. */
  // SQL uses snake_case column names (document_idx), not the camelCase from generated types.
  const changeQueries = (range: { min: number; max: number; wraps: boolean }) =>
    range.wraps
      ? [
          `SELECT * FROM checkbox_changes WHERE document_idx >= ${range.min}`,
          `SELECT * FROM checkbox_changes WHERE document_idx <= ${range.max}`,
        ]
      : [`SELECT * FROM checkbox_changes WHERE document_idx >= ${range.min} AND document_idx <= ${range.max}`];

  /**
   * Two-phase subscription for a document range (no table overlap).
   *
   * Phase 1: Subscribe to full checkboxes rows ONLY.
   *          Once onApplied fires, boxesStore has all docs for this range.
   *
   * Phase 2: Subscribe to checkbox_changes ONLY, then drop Phase 1.
   *          Live updates cost ~24 bytes instead of ~2KB. No subscription
   *          overlap (different tables) → exactly 1 message per toggle.
   */
  let phase1Handle: SubscriptionHandle | null = null;

  /** Safely unsubscribe a handle, ignoring already-ended handles. */
  const safeUnsub = (h: SubscriptionHandle | null) => {
    if (!h) return;
    try { if (!h.isEnded()) h.unsubscribe(); } catch { /* already ended */ }
  };

  const subscribeToRange = (range: { min: number; max: number; wraps: boolean }) => {
    const fullQueries = range.wraps
      ? [
          `SELECT * FROM checkboxes WHERE idx >= ${range.min}`,
          `SELECT * FROM checkboxes WHERE idx <= ${range.max}`,
        ]
      : [`SELECT * FROM checkboxes WHERE idx >= ${range.min} AND idx <= ${range.max}`];

    // Bump generation so stale onApplied callbacks become no-ops
    const gen = ++subGeneration;

    // Collect ALL handles that need cleanup (Set deduplicates)
    const toCleanup = new Set<SubscriptionHandle>();
    if (currentSubHandle) toCleanup.add(currentSubHandle);
    if (phase1Handle) toCleanup.add(phase1Handle);

    // Phase 1: full docs ONLY (no checkbox_changes — avoids subscription
    // overlap that causes duplicate messages when Phase 2 also covers changes)
    const p1Handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        // Stale callback — a newer subscribeToRange already took over
        if (gen !== subGeneration) {
          safeUnsub(p1Handle);
          return;
        }

        // Clean up all previous handles
        for (const h of toCleanup) safeUnsub(h);

        if (!subscriptionResolved) {
          subscriptionResolved = true;
          resolveSubscription();
        }

        // Phase 2: change events only — lightweight live updates (24 bytes
        // instead of 2KB). No overlap with Phase 1 (different tables).
        currentSubHandle = conn
          .subscriptionBuilder()
          .onApplied(() => {
            // Stale — a newer subscribeToRange already took over
            if (gen !== subGeneration) return;
            // Phase 2 is live — drop Phase 1 (full docs)
            safeUnsub(p1Handle);
            if (phase1Handle === p1Handle) phase1Handle = null;
          })
          .subscribe(changeQueries(range));
      })
      .subscribe(fullQueries);

    phase1Handle = p1Handle;
    subscribedMin = range.min;
    subscribedMax = range.max;
  };

  // Reset subscription state on disconnect so reconnect triggers a fresh Phase 1.
  // Without this, subscribedMin/Max retain stale values and isInSubscribedRange
  // would prevent re-subscribing even though the old handles are dead.
  createEffect(
    () => isConnected(),
    (connected) => {
      if (!connected) {
        subscribedMin = -1;
        subscribedMax = -1;
        currentSubHandle = null;
        phase1Handle = null;
      }
    },
  );

  /** Effect: watch visible range and connection state, update subscription. */
  createEffect(
    () => ({ range: visibleDocRange(), connected: isConnected() }),
    ({ range, connected }) => {
      if (!range || !connected) return;

      // First subscription or reconnect — immediate
      if (subscribedMin === -1) {
        subscribeToRange(range);
        return;
      }

      // Only resubscribe if visible edge has moved outside subscribed range
      if (isInSubscribedRange(range.min) && isInSubscribedRange(range.max)) {
        return;
      }

      // Debounce to avoid thrashing during fast scroll
      clearTimeout(subDebounceTimer);
      subDebounceTimer = window.setTimeout(() => {
        const fresh = visibleDocRange();
        if (fresh) subscribeToRange(fresh);
      }, 200);
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
      setScrollbarWidth(scrollRef.offsetWidth - scrollRef.clientWidth);

      // Scroll → offset + URL (skip if this scroll was triggered by input)
      if (!scrollFromInput) {
        const cols = numColumns();
        const topRow = Math.floor((scrollRef.scrollTop * scrollScale()) / CELL_SIZE);
        const offset = Math.min(topRow * cols, NUM_BOXES - 1);
        setCurrentOffset(offset);

        clearTimeout(urlUpdateTimer);
        urlUpdateTimer = window.setTimeout(() => syncOffsetToUrl(offset), 300);
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

    // Optimistic count adjustment
    const wasColored = currentColor > 0;
    const isColored = newColor > 0;
    if (wasColored !== isColored) {
      setPendingCountDelta((d) => d + (isColored ? 1 : -1));
    }

    setPendingStore(s => {
      if (!s[documentIdx]) s[documentIdx] = {};
      s[documentIdx][arrayIdx] = newColor;
    });

    const cellKey = `${documentIdx}:${arrayIdx}`;
    const existing = inflightCells.get(cellKey);
    inflightCells.set(cellKey, {
      time: existing?.time ?? performance.now(),
      count: (existing?.count ?? 0) + 1,
    });
    setPendingToggleCount((c) => c + 1);
    if (!inflightGcTimer) inflightGcTimer = window.setTimeout(gcInflightCells, 2000);

    conn.reducers.toggle({ documentIdx, arrayIdx, color: newColor }).catch(() => {
      setRateLimited(true);
      clearTimeout(rateLimitFadeTimer);
      rateLimitFadeTimer = window.setTimeout(() => setRateLimited(false), 2000);
    });
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
                        syncOffsetToUrl(actual);
                      }
                      e.currentTarget.blur();
                    }
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                />
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
                  class={`palette-btn ${selectedColor() === i() ? "palette-btn-selected" : "palette-btn-unselected"}`}
                  onClick={() => setSelectedColor(i())}
                  title={i() === 0 ? "Clear (uncheck)" : `Color ${i()}`}
                  style={{
                    "background-color": i() === 0 ? "#fff" : colorAccessor(),
                  }}
                >
                  {i() === 0 ? "✕" : ""}
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
                </div>
              </div>
            </div>
          </Show>
        </Loading>
      </div>
    </div>
  );
}
