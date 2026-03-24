/**
 * Main UI — renders a virtual grid of 1,000,000,000 checkboxes via canvas.
 *
 * Data model:
 *   1B checkboxes across 250,000 DB rows ("documents").
 *   Each document holds 4,000 checkboxes packed as nibbles (4 bits, 2 per byte).
 *   Nibble 0 = unchecked; 1-15 = color index. Missing rows are all-zero.
 *   Checkbox N maps to: documentIdx = N % 250000, arrayIdx = floor(N / 250000).
 *
 * Rendering:
 *   A single <canvas> draws visible cells. A scroll container beneath provides
 *   the native scrollbar. The canvas is sized to exclude the scrollbar width.
 *   Repaints are driven by a reactive effect tracking scroll, size, and data.
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
} from 'solid-js';
import { conn, isConnected } from './main.tsx';
import type { EventContext } from './module_bindings/index.ts';
import type { Checkboxes } from './module_bindings/types.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const NUM_BOXES = 1_000_000_000;
const NUM_DOCUMENTS = 250_000;
const CELL_SIZE = 22; // px

const PALETTE: string[] = [
  '#f3f4f6', // 0: clear / uncheck
  '#111827', // 1: near-black
  '#dc2626', // 2: red
  '#ea580c', // 3: orange
  '#d97706', // 4: amber
  '#16a34a', // 5: green
  '#0891b2', // 6: cyan
  '#2563eb', // 7: blue
  '#7c3aed', // 8: purple
  '#db2777', // 9: pink
  '#f87171', // 10: light red
  '#fb923c', // 11: light orange
  '#fbbf24', // 12: yellow
  '#4ade80', // 13: light green
  '#38bdf8', // 14: sky blue
  '#a78bfa', // 15: lavender
];

// ─── Nibble helpers ────────────────────────────────────────────────────────────

function getColor(boxes: number[], arrayIdx: number): number {
  const byte = boxes[Math.floor(arrayIdx / 2)] || 0;
  return arrayIdx % 2 === 0 ? (byte & 0x0f) : (byte >> 4) & 0x0f;
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
  const [boxesMap, setBoxesMap] = createSignal(
    new Map<number, number[]>(),
    { equals: false },
  );

  const [numCheckedBoxes, setNumCheckedBoxes] = createSignal(0);
  const docColorCounts = new Map<number, number>();

  // ── Async subscription + canvas readiness ─────────────────────────────
  let resolveSubscription!: () => void;
  const subscriptionPromise = new Promise<void>(res => { resolveSubscription = res; });

  // Single async memo gates <Loading> — resolves when subscription data
  // is loaded AND the container has been measured (so canvas can paint).
  const [containerMeasured, setContainerMeasured] = createSignal(false);

  const gridReady = createMemo(async () => {
    await subscriptionPromise;
    // Wait for container measurement before resolving
    await new Promise<void>(res => {
      const check = () => {
        if (containerMeasured()) { res(); return; }
        // Poll briefly — ResizeObserver fires within a frame or two
        requestAnimationFrame(check);
      };
      check();
    });
    return true as const;
  });

  // isPending() read OUTSIDE <Loading> so the header observes but never suspends.
  const isSyncing = () => isPending(() => gridReady());

  // ── Pending optimistic writes ─────────────────────────────────────────
  const [pendingUpdates, setPendingUpdates] = createSignal(
    new Map<number, Map<number, number>>(),
  );

  // ── Round-trip timing ─────────────────────────────────────────────────
  // Per-document: { time: earliest pending timestamp, count: toggles in-flight }
  const inflightDocs = new Map<number, { time: number; count: number }>();
  const [pendingToggleCount, setPendingToggleCount] = createSignal(0);
  const [lastRoundTripMs, setLastRoundTripMs] = createSignal<number | null>(null);
  let roundTripFadeTimer = 0;

  // ── UI state ──────────────────────────────────────────────────────────
  const [selectedColor, setSelectedColor] = createSignal(1);

  // ── Virtual scroll state ──────────────────────────────────────────────
  let containerRef!: HTMLDivElement;
  let scrollRef!: HTMLDivElement;
  let canvasRef!: HTMLCanvasElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollbarWidth, setScrollbarWidth] = createSignal(0);

  /** Measure scrollbar width from the scroll container. */
  const measureScrollbar = () => {
    if (scrollRef) {
      setScrollbarWidth(scrollRef.offsetWidth - scrollRef.clientWidth);
    }
  };

  // ── One-time setup after mount ────────────────────────────────────────
  onSettled(() => {
    const obs = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) {
        setSize({ width: e.contentRect.width, height: e.contentRect.height });
        if (!containerMeasured()) setContainerMeasured(true);
        // Re-measure scrollbar on resize
        measureScrollbar();
      }
    });
    obs.observe(containerRef);
    onCleanup(() => obs.disconnect());

    // SpacetimeDB event handlers
    const upsertRow = (row: Checkboxes) => {
      const boxes = Array.from(row.boxes);
      setBoxesMap(map => { map.set(row.idx, boxes); return map; });

      const newCount = countColored(boxes);
      const oldCount = docColorCounts.get(row.idx) ?? 0;
      docColorCounts.set(row.idx, newCount);
      setNumCheckedBoxes(prev => prev + newCount - oldCount);

      // Clear pending optimistic overlay
      setPendingUpdates(prev => {
        if (!prev.has(row.idx)) return prev;
        const next = new Map(prev);
        next.delete(row.idx);
        return next;
      });

      // Compute round-trip time
      const inflight = inflightDocs.get(row.idx);
      if (inflight) {
        inflightDocs.delete(row.idx);
        const ms = Math.round(performance.now() - inflight.time);
        setLastRoundTripMs(ms);
        setPendingToggleCount(c => Math.max(0, c - inflight.count));

        clearTimeout(roundTripFadeTimer);
        roundTripFadeTimer = window.setTimeout(() => setLastRoundTripMs(null), 2000);
      }
    };

    conn.db.checkboxes.onInsert((_ctx: EventContext, row: Checkboxes) => upsertRow(row));
    conn.db.checkboxes.onUpdate((_ctx: EventContext, _old: Checkboxes, row: Checkboxes) => upsertRow(row));

    conn.db.checkboxes.onDelete((_ctx: EventContext, row: Checkboxes) => {
      setBoxesMap(map => { map.delete(row.idx); return map; });
      const oldCount = docColorCounts.get(row.idx) ?? 0;
      docColorCounts.delete(row.idx);
      setNumCheckedBoxes(prev => prev - oldCount);
    });

    conn
      .subscriptionBuilder()
      .onApplied(() => resolveSubscription())
      .subscribe(['SELECT * FROM checkboxes']);
  });

  // ── Derived scroll values ─────────────────────────────────────────────
  const numColumns = () => Math.max(1, Math.floor(size().width / CELL_SIZE));
  const numRows = () => Math.ceil(NUM_BOXES / numColumns());
  const totalHeight = () => numRows() * CELL_SIZE;
  const canvasWidth = () => Math.max(0, size().width - scrollbarWidth());
  const canvasHeight = () => size().height;

  // ── Side effects ──────────────────────────────────────────────────────

  createEffect(
    () => numCheckedBoxes(),
    (count) => {
      document.title = `${count.toLocaleString()} colored — One Billion Checkboxes`;
    },
  );

  // ── Scroll handler (rAF-throttled) ────────────────────────────────────
  let rafId = 0;
  const onScroll = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      if (!scrollRef) return;
      setScrollTop(scrollRef.scrollTop);
      measureScrollbar();
    });
  };

  // ── Toggle handler ────────────────────────────────────────────────────
  const loading = () => !isConnected() || !gridReady();

  const toggle = (documentIdx: number, arrayIdx: number) => {
    if (loading()) return;

    const base = boxesMap().get(documentIdx);
    const pending = pendingUpdates().get(documentIdx);

    let currentColor = 0;
    if (pending?.has(arrayIdx)) {
      currentColor = pending.get(arrayIdx)!;
    } else if (base) {
      currentColor = getColor(base, arrayIdx);
    }

    const newColor =
      currentColor === selectedColor() && selectedColor() !== 0 ? 0 : selectedColor();

    setPendingUpdates(prev => {
      const next = new Map(prev);
      const docMap = new Map(next.get(documentIdx) ?? []);
      docMap.set(arrayIdx, newColor);
      next.set(documentIdx, docMap);
      return next;
    });

    // Track round-trip timing — keep earliest timestamp per doc, increment count
    const existing = inflightDocs.get(documentIdx);
    inflightDocs.set(documentIdx, {
      time: existing?.time ?? performance.now(),
      count: (existing?.count ?? 0) + 1,
    });
    setPendingToggleCount(c => c + 1);

    conn.reducers.toggle({ documentIdx, arrayIdx, color: newColor });
  };

  // ── Canvas paint ──────────────────────────────────────────────────────

  const getCellColor = (
    boxes: Map<number, number[]>,
    pending: Map<number, Map<number, number>>,
    documentIdx: number,
    arrayIdx: number,
  ): number => {
    const docPending = pending.get(documentIdx);
    if (docPending?.has(arrayIdx)) return docPending.get(arrayIdx)!;
    const docBoxes = boxes.get(documentIdx);
    return docBoxes ? getColor(docBoxes, arrayIdx) : 0;
  };

  let cachedCtx: CanvasRenderingContext2D | null = null;
  let lastDpr = 0;

  const paintGrid = () => {
    const canvas = canvasRef;
    if (!canvas) return;

    const cw = canvasWidth();
    const ch = canvasHeight();
    if (cw <= 0 || ch <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const bufW = Math.round(cw * dpr);
    const bufH = Math.round(ch * dpr);

    if (canvas.width !== bufW || canvas.height !== bufH) {
      canvas.width = bufW;
      canvas.height = bufH;
      cachedCtx = null;
    }

    if (!cachedCtx || dpr !== lastDpr) {
      cachedCtx = canvas.getContext('2d', { alpha: false })!;
      if (!cachedCtx) return;
      cachedCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastDpr = dpr;
    }

    const ctx2d = cachedCtx;
    ctx2d.fillStyle = '#fff';
    ctx2d.fillRect(0, 0, cw, ch);

    const cols = numColumns();
    const sTop = scrollTop();
    const firstRow = Math.max(0, Math.floor(sTop / CELL_SIZE));
    const lastRow = Math.min(numRows() - 1, Math.ceil((sTop + ch) / CELL_SIZE));
    const boxes = boxesMap();
    const pending = pendingUpdates();

    const innerSize = CELL_SIZE - 2;

    // Pass 1: empty cell borders
    ctx2d.strokeStyle = '#e5e7eb';
    ctx2d.lineWidth = 1;
    for (let row = firstRow; row <= lastRow; row++) {
      const y = row * CELL_SIZE - sTop;
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (index >= NUM_BOXES) break;

        const documentIdx = index % NUM_DOCUMENTS;
        const arrayIdx = Math.floor(index / NUM_DOCUMENTS);
        const colorVal = getCellColor(boxes, pending, documentIdx, arrayIdx);

        if (colorVal === 0) {
          const cx = col * CELL_SIZE + 1.5;
          const cy = y + 1.5;
          ctx2d.beginPath();
          ctx2d.roundRect(cx, cy, innerSize - 1, innerSize - 1, 3);
          ctx2d.stroke();
        }
      }
    }

    // Pass 2: filled cells
    let currentFill = '';
    ctx2d.lineWidth = 2;
    ctx2d.lineCap = 'round';
    ctx2d.lineJoin = 'round';

    for (let row = firstRow; row <= lastRow; row++) {
      const y = row * CELL_SIZE - sTop;
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (index >= NUM_BOXES) break;

        const documentIdx = index % NUM_DOCUMENTS;
        const arrayIdx = Math.floor(index / NUM_DOCUMENTS);
        const colorVal = getCellColor(boxes, pending, documentIdx, arrayIdx);

        if (colorVal > 0) {
          const cx = col * CELL_SIZE + 1;
          const cy = y + 1;

          const fill = PALETTE[colorVal];
          if (fill !== currentFill) {
            currentFill = fill;
            ctx2d.fillStyle = fill;
          }

          ctx2d.beginPath();
          ctx2d.roundRect(cx, cy, innerSize, innerSize, 3);
          ctx2d.fill();

          // Checkmark
          ctx2d.strokeStyle = '#fff';
          ctx2d.beginPath();
          ctx2d.moveTo(cx + innerSize * 0.22, cy + innerSize * 0.50);
          ctx2d.lineTo(cx + innerSize * 0.42, cy + innerSize * 0.72);
          ctx2d.lineTo(cx + innerSize * 0.78, cy + innerSize * 0.30);
          ctx2d.stroke();
        }
      }
    }
  };

  // Repaint whenever scroll, data, or size changes
  createEffect(
    () => {
      scrollTop();
      size();
      scrollbarWidth();
      boxesMap();
      pendingUpdates();
      numColumns();
    },
    () => paintGrid(),
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100vh',
        width: '100vw',
        'box-sizing': 'border-box',
        overflow: 'hidden',
        'font-family': 'system-ui, sans-serif',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'center',
          padding: '8px 12px',
          'border-bottom': '1px solid #e5e7eb',
          background: '#fff',
          'flex-shrink': '0',
          gap: '12px',
          'flex-wrap': 'wrap',
        }}
      >
        <div>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
            <span style={{ 'font-weight': '700', 'font-size': '1rem' }}>
              One Billion Checkboxes
            </span>
            {/* Connection spinner */}
            <Show when={isSyncing()}>
              <span
                aria-label="Connecting…"
                style={{
                  display: 'inline-block',
                  width: '10px',
                  height: '10px',
                  border: '2px solid #e5e7eb',
                  'border-top-color': '#6b7280',
                  'border-radius': '50%',
                  animation: 'spin 0.75s linear infinite',
                  'flex-shrink': '0',
                }}
              />
            </Show>
            {/* Toggle round-trip indicator — fixed width to prevent layout shift */}
            <span style={{
              display: 'inline-flex',
              'align-items': 'center',
              'justify-content': 'center',
              'min-width': '38px',
              'font-size': '0.7rem',
              'font-variant-numeric': 'tabular-nums',
              opacity: !isSyncing() && (pendingToggleCount() > 0 || lastRoundTripMs() !== null) ? '1' : '0',
              transition: 'opacity 0.2s ease-out',
            }}>
              <Show when={pendingToggleCount() > 0} fallback={
                <span style={{ color: '#16a34a' }}>{lastRoundTripMs()}ms</span>
              }>
                <span
                  style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    border: '1.5px solid #e5e7eb',
                    'border-top-color': '#9ca3af',
                    'border-radius': '50%',
                    animation: 'spin 0.6s linear infinite',
                  }}
                />
                </Show>
            </span>
          </div>
          <div style={{ color: '#6b7280', 'font-size': '0.8rem', 'margin-top': '2px' }}>
            {isSyncing()
              ? 'Connecting…'
              : `${numCheckedBoxes().toLocaleString()} colored`}
          </div>
        </div>

        {/* Color palette */}
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            'flex-wrap': 'wrap',
          }}
        >
          <span style={{ 'font-size': '0.75rem', color: '#9ca3af' }}>Color:</span>
          <div style={{ display: 'flex', gap: '3px', 'flex-wrap': 'wrap' }}>
            <For each={PALETTE} keyed={false}>
              {(colorAccessor, i) => (
                <button
                  onClick={() => setSelectedColor(i())}
                  title={i() === 0 ? 'Clear (uncheck)' : `Color ${i()}`}
                  style={{
                    width: '20px',
                    height: '20px',
                    'background-color': i() === 0 ? '#fff' : colorAccessor(),
                    border:
                      selectedColor() === i()
                        ? '2px solid #1f2937'
                        : '1px solid #d1d5db',
                    'border-radius': '3px',
                    cursor: 'pointer',
                    padding: '0',
                    'font-size': '9px',
                    color: '#374151',
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    'flex-shrink': '0',
                  }}
                >
                  {i() === 0 ? '✕' : ''}
                </button>
              )}
            </For>
          </div>
        </div>

        <div style={{ 'font-size': '0.75rem', color: '#9ca3af', 'text-align': 'right' }}>
          <a
            style={{ 'text-decoration': 'none', color: '#6b7280' }}
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
        style={{ 'flex-grow': '1', overflow: 'hidden', position: 'relative' }}
      >
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Loading {...{ on: gridReady } as any} fallback={
          <div style={{
            display: 'flex',
            'flex-direction': 'column',
            'align-items': 'center',
            'justify-content': 'center',
            height: '100%',
            gap: '10px',
            color: '#9ca3af',
            'font-family': 'system-ui, sans-serif',
          }}>
            <span style={{
              display: 'inline-block',
              width: '28px',
              height: '28px',
              border: '3px solid #e5e7eb',
              'border-top-color': '#6b7280',
              'border-radius': '50%',
              animation: 'spin 0.75s linear infinite',
            }} />
            <span style={{ 'font-size': '0.875rem' }}>
              {isConnected() ? 'Loading checkboxes…' : 'Connecting to SpacetimeDB…'}
            </span>
          </div>
        }>
          <Show when={gridReady()}>
          {/* Scroll container — tall spacer provides the native scrollbar */}
          <div
            ref={(el: HTMLDivElement) => {
              scrollRef = el;
              // Measure scrollbar as soon as the scroll container mounts
              requestAnimationFrame(() => measureScrollbar());
            }}
            style={{ width: '100%', height: '100%', overflow: 'auto' }}
            onScroll={onScroll}
          >
            <div style={{ height: `${totalHeight()}px`, width: `${numColumns() * CELL_SIZE}px` }} />
          </div>
          {/* Canvas sized to exclude the scrollbar — no overlap */}
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              top: '0',
              left: '0',
              width: `${canvasWidth()}px`,
              height: `${canvasHeight()}px`,
              cursor: loading() ? 'default' : 'pointer',
            }}
            onWheel={(e) => {
              scrollRef.scrollTop += e.deltaY;
              scrollRef.scrollLeft += e.deltaX;
              e.preventDefault();
            }}
            onClick={(e) => {
              if (loading()) return;
              const rect = canvasRef.getBoundingClientRect();
              const mx = e.clientX - rect.left;
              const my = e.clientY - rect.top;
              const col = Math.floor(mx / CELL_SIZE);
              const row = Math.floor((my + scrollTop()) / CELL_SIZE);
              const cols = numColumns();
              if (col >= cols) return;
              const index = row * cols + col;
              if (index >= NUM_BOXES) return;
              const documentIdx = index % NUM_DOCUMENTS;
              const arrayIdx = Math.floor(index / NUM_DOCUMENTS);
              toggle(documentIdx, arrayIdx);
            }}
          />
          </Show>
        </Loading>
      </div>
    </div>
  );
}
