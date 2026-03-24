/**
 * Main UI — renders a virtual grid of 1,000,000,000 checkboxes.
 *
 * Data model:
 *   Same as before: 1B checkboxes across 250,000 DB rows ("documents").
 *   Each document holds 4,000 checkboxes packed as nibbles (4 bits, 2 per byte).
 *   Nibble 0 = unchecked; 1-15 = color index. Missing rows are all-zero.
 *   Checkbox N maps to: documentIdx = N % 250000, arrayIdx = floor(N / 250000).
 *
 * SolidJS 2.0 patterns used:
 *   • createSignal / createMemo          — reactive state and derived values
 *   • onSettled (replaces onMount)        — one-time side-effect setup after mount
 *   • onCleanup                           — cleanup on unmount
 *   • createEffect(computeFn, applyFn)    — two-phase effect (2.0 change):
 *       Phase 1 "compute" runs in tracking context and returns a value.
 *       Phase 2 "apply" receives that value and performs the side effect
 *       outside any reactive tracking context, preventing infinite loops.
 *   • <For> with keyed={false}            — replaces <Index> from 1.x
 *   • Optimistic updates via pendingUpdates signal — applied on top of the
 *       server-confirmed boxesMap; cleared when SpacetimeDB confirms each row.
 *   • createMemo(async fn)               — SolidJS 2.0 native async memo; no
 *       createAsync wrapper needed. Returning a Promise from createMemo marks the
 *       computation as async. The reactivity system tracks its pending state so
 *       isPending() and <Loading> work automatically.
 *   • isPending(() => expr)              — returns true while any async memo
 *       inside the thunk is still resolving. Read OUTSIDE a Loading/Suspense
 *       boundary so this component itself does not suspend.
 *   • <Loading on={memo} fallback={…}>   — shows fallback only on initial load;
 *       subsequent background refreshes keep the old UI visible and instead
 *       make isPending() return true inside. <Suspense> is fully removed in
 *       SolidJS 2.0; <Loading> is its replacement. The `on` prop explicitly
 *       binds the async dependency to watch.
 *
 * Virtual scrolling:
 *   Implemented without a library. A ResizeObserver tracks the container
 *   size; scroll position drives a memo that computes only the visible row
 *   range (+OVERSCAN). Each visible row renders numColumns cells inline —
 *   no column virtualisation needed because numColumns = floor(width/12) is
 *   always small enough to render directly (~80-300 per row).
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
const OVERSCAN = 3;   // extra rows rendered beyond the visible edge

/**
 * 16-color palette: index 0 = "clear/uncheck", indices 1-15 = colors.
 */
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

/** Read the 4-bit nibble color for arrayIdx from a byte array. */
function getColor(boxes: number[], arrayIdx: number): number {
  const byte = boxes[Math.floor(arrayIdx / 2)] || 0;
  return arrayIdx % 2 === 0 ? (byte & 0x0f) : (byte >> 4) & 0x0f;
}

/**
 * Return a new copy of `boxes` with the nibble at `arrayIdx` set to `color`.
 * Used for optimistic updates — never mutates the original array.
 */
function applyNibble(boxes: number[], arrayIdx: number, color: number): number[] {
  const byteIdx = Math.floor(arrayIdx / 2);
  const copy = [...boxes];
  const byte = copy[byteIdx] ?? 0;
  copy[byteIdx] =
    arrayIdx % 2 === 0
      ? (byte & 0xf0) | (color & 0x0f)
      : (byte & 0x0f) | ((color & 0x0f) << 4);
  return copy;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {
  // ── Table state ──────────────────────────────────────────────────────────
  const [checkboxRows, setCheckboxRows] = createSignal<Checkboxes[]>([]);

  // ── Async subscription readiness ──────────────────────────────────────────
  //
  // In SolidJS 2.0, createMemo can return a Promise — no createAsync needed.
  // The reactivity system treats any memo that returns a Promise as "async":
  //   • isPending(() => subscriptionReady()) → true while the Promise is pending
  //   • Reading subscriptionReady() inside a <Loading> boundary causes it to
  //     show the fallback until the Promise resolves
  //
  // We bridge SpacetimeDB's callback-based onApplied into a Promise using a
  // simple resolver variable captured at construction time.
  let resolveSubscription!: () => void;
  const subscriptionPromise = new Promise<void>(res => { resolveSubscription = res; });

  const subscriptionReady = createMemo(async () => {
    await subscriptionPromise;
    return true as const;
  });

  // ── Global pending indicator ──────────────────────────────────────────────
  //
  // isPending() takes a thunk; returns true when any async memo accessed
  // inside that thunk is still resolving its Promise.
  //
  // Called HERE — outside any <Loading> boundary — so reading subscriptionReady()
  // inside the thunk does NOT cause this component to suspend. It only observes
  // the pending state without participating in it.
  const isSyncing = () => isPending(() => subscriptionReady());

  /**
   * Pending optimistic nibble writes that haven't been confirmed by the server
   * yet.  Shape: Map<documentIdx, Map<arrayIdx, color>>.
   * Cleared per-document the moment SpacetimeDB delivers the confirmed row.
   */
  const [pendingUpdates, setPendingUpdates] = createSignal(
    new Map<number, Map<number, number>>(),
  );

  // ── UI state ─────────────────────────────────────────────────────────────
  const [selectedColor, setSelectedColor] = createSignal(1);

  // ── Virtual scroll state ─────────────────────────────────────────────────
  let containerRef!: HTMLDivElement; // outer flex-child that holds the scroll div
  let scrollRef!: HTMLDivElement;    // the actual overflow:auto element
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = createSignal(0);

  // ── One-time setup after mount ────────────────────────────────────────────
  //
  // onSettled is SolidJS 2.0's replacement for onMount. It fires after the
  // component's initial DOM is settled (including any async work). We use it
  // for two things that must run exactly once:
  //   1. Wire up the ResizeObserver for container dimensions.
  //   2. Register SpacetimeDB row-event callbacks and start the subscription.
  //
  onSettled(() => {
    // 1. Container resize tracking
    const obs = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setSize({ width: e.contentRect.width, height: e.contentRect.height });
    });
    obs.observe(containerRef);
    onCleanup(() => obs.disconnect());

    // 2a. SpacetimeDB event handlers — called for every row insert/update/delete
    //     that arrives over the WebSocket after the subscription is active.
    conn.db.checkboxes.onInsert((_ctx: EventContext, row: Checkboxes) => {
      setCheckboxRows((prev) => [...prev.filter((r) => r.idx !== row.idx), row]);
      // A confirmed insert for this document supersedes any optimistic state.
      setPendingUpdates((prev) => {
        if (!prev.has(row.idx)) return prev;
        const next = new Map(prev);
        next.delete(row.idx);
        return next;
      });
    });

    conn.db.checkboxes.onUpdate(
      (_ctx: EventContext, _old: Checkboxes, row: Checkboxes) => {
        setCheckboxRows((prev) => prev.map((r) => (r.idx === row.idx ? row : r)));
        // Server-confirmed update — drop the optimistic overlay for this doc.
        setPendingUpdates((prev) => {
          if (!prev.has(row.idx)) return prev;
          const next = new Map(prev);
          next.delete(row.idx);
          return next;
        });
      },
    );

    conn.db.checkboxes.onDelete((_ctx: EventContext, row: Checkboxes) => {
      setCheckboxRows((prev) => prev.filter((r) => r.idx !== row.idx));
    });

    // 2b. Subscribe — SpacetimeDB will replay all existing rows via onInsert,
    //     then fire onApplied to signal that the initial snapshot is complete.
    //     Resolving subscriptionPromise here unblocks the async memo above,
    //     which in turn makes isPending() return false and <Loading> render
    //     the grid content instead of the connecting fallback.
    conn
      .subscriptionBuilder()
      .onApplied(() => resolveSubscription())
      .subscribe(['SELECT * FROM checkboxes']);
  });

  // ── Derived state (memos) ─────────────────────────────────────────────────

  /** Index confirmed rows by documentIdx for O(1) lookup in each cell. */
  const boxesMap = createMemo(() => {
    const map = new Map<number, number[]>();
    for (const row of checkboxRows()) {
      map.set(row.idx, Array.from(row.boxes));
    }
    return map;
  });

  /**
   * Server state merged with any not-yet-confirmed local writes.
   * Returns a new Map only when either source changes; SolidJS will only
   * re-evaluate downstream computations when this memo's return value changes.
   */
  const optimisticBoxesMap = createMemo(() => {
    const base = boxesMap();
    const pending = pendingUpdates();
    if (pending.size === 0) return base;

    const result = new Map(base);
    for (const [docIdx, updates] of pending) {
      const currentBoxes = result.get(docIdx) ?? new Array(2000).fill(0);
      let boxes = [...currentBoxes];
      for (const [arrIdx, color] of updates) {
        boxes = applyNibble(boxes, arrIdx, color);
      }
      result.set(docIdx, boxes);
    }
    return result;
  });

  /** Count of all colored (non-zero nibble) cells across loaded documents. */
  const numCheckedBoxes = createMemo(() => {
    let count = 0;
    for (const boxes of optimisticBoxesMap().values()) {
      for (const byte of boxes) {
        if (byte === 0) continue;
        if (byte & 0x0f) count++;
        if (byte >> 4) count++;
      }
    }
    return count;
  });

  // ── Virtual scroll derived values ─────────────────────────────────────────
  const numColumns = () => Math.max(1, Math.floor(size().width / CELL_SIZE));
  const numRows = () => Math.ceil(NUM_BOXES / numColumns());
  const totalHeight = () => numRows() * CELL_SIZE;

  const firstVisibleRow = () =>
    Math.max(0, Math.floor(scrollTop() / CELL_SIZE) - OVERSCAN);
  const lastVisibleRow = () =>
    Math.min(
      numRows() - 1,
      Math.floor((scrollTop() + size().height) / CELL_SIZE) + OVERSCAN,
    );

  /** Stable array of row indices to render, recomputed only on scroll/resize. */
  const visibleRowIndices = createMemo(() => {
    const rows: number[] = [];
    for (let r = firstVisibleRow(); r <= lastVisibleRow(); r++) rows.push(r);
    return rows;
  });

  // ── Side effects ──────────────────────────────────────────────────────────

  /**
   * SolidJS 2.0 two-phase createEffect:
   *
   *   createEffect(computeFn, applyFn)
   *
   *   Phase 1 — "compute": runs inside a reactive tracking context.
   *     Reading signals here registers them as dependencies; this phase
   *     runs again whenever any dependency changes.
   *
   *   Phase 2 — "apply": receives the value returned by computeFn and runs
   *     the actual side effect *outside* the tracking context, so accessing
   *     signals here does NOT create additional dependencies and cannot cause
   *     feedback loops.
   *
   * In SolidJS 1.x a single createEffect(fn) did both tracking and side
   * effects in one pass, which could cause subtle re-entrancy bugs. The 2.0
   * split makes the contract explicit and mirrors the way browser rendering
   * separates layout (read) from paint (write).
   */
  createEffect(
    // Phase 1 — compute: track numCheckedBoxes
    () => numCheckedBoxes(),
    // Phase 2 — apply: update document title (DOM write, untracked)
    (count) => {
      document.title = `${count.toLocaleString()} colored — One Billion Checkboxes`;
    },
  );

  // ── Scroll handler (rAF-throttled) ────────────────────────────────────────
  let rafId = 0;
  const onScroll = (e: Event) => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      setScrollTop((e.target as HTMLElement).scrollTop);
    });
  };

  // ── Toggle handler ────────────────────────────────────────────────────────
  // subscriptionReady() returns true once resolved, undefined while pending.
  const loading = () => !isConnected() || !subscriptionReady();

  const toggle = (documentIdx: number, arrayIdx: number) => {
    if (loading()) return;

    const boxes = optimisticBoxesMap().get(documentIdx);
    const currentColor = boxes ? getColor(boxes, arrayIdx) : 0;
    // Clicking a cell that already has the selected color clears it (toggle off).
    const newColor =
      currentColor === selectedColor() && selectedColor() !== 0 ? 0 : selectedColor();

    // Apply optimistic update immediately so the UI feels instant.
    setPendingUpdates((prev) => {
      const next = new Map(prev);
      const docMap = new Map(next.get(documentIdx) ?? []);
      docMap.set(arrayIdx, newColor);
      next.set(documentIdx, docMap);
      return next;
    });

    // Fire the server reducer; SpacetimeDB will confirm via onInsert/onUpdate
    // which clears the pending entry above.
    conn.reducers.toggle({ documentIdx, arrayIdx, color: newColor });
  };

  // ── Column index array helper ─────────────────────────────────────────────
  //
  // createMemo so we don't rebuild the array on every re-render; only when
  // numColumns changes (i.e. on window resize).
  //
  const columnIndices = createMemo(() =>
    Array.from({ length: numColumns() }, (_, i) => i),
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
            {/*
              Global isPending indicator.
              isPending() is read OUTSIDE <Loading> so the header never suspends —
              it just observes whether the async subscriptionReady memo is still
              in-flight and shows a spinner while it is.
            */}
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
            {/*
              <For> with keyed={false} is the SolidJS 2.0 replacement for
              <Index> from 1.x. Items are identified by position rather than
              value, so the item callback receives an accessor (fn) for the
              value and a plain number for the index — matching the old
              <Index> contract. Use it when the identity of each item is its
              stable position in the array (e.g. a static palette list).
            */}
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
        {/*
          <Loading> — SolidJS 2.0 async boundary.
          NOTE: <Suspense> is fully removed in 2.0; <Loading> replaces it.

          Props used:
            on={subscriptionReady}   — the memo accessor to watch. Loading tracks
              this async dependency directly rather than relying on subscriptionReady()
              being read somewhere inside the children tree.
            fallback={…}             — rendered while the async memo is pending.

          Behaviour vs the old <Suspense>:
            • <Suspense> tore down children on EVERY async transition.
            • <Loading> shows the fallback only on the INITIAL load. After that,
              background refreshes keep the existing UI stable and instead make
              isPending() return true (used above for the header spinner).
          Once subscriptionReady resolves, <Loading> renders the grid permanently —
          real-time WebSocket updates flow through signals, not new async boundaries.
        */}
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Loading {...{ on: subscriptionReady } as any} fallback={
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
            <span style={{ 'font-size': '0.875rem' }}>Connecting to SpacetimeDB…</span>
          </div>
        }>
          {/*
            subscriptionReady() is read here — inside the <Loading> boundary.
            While its underlying Promise is pending, SolidJS suspends this
            subtree and <Loading> renders the fallback above instead.
            Once the Promise resolves, the grid renders and stays rendered.
            The size().width > 0 guard prevents a 1B-row flash before the
            ResizeObserver fires.
          */}
          <Show when={subscriptionReady() && size().width > 0}>
          <div
            ref={scrollRef}
            style={{ width: '100%', height: '100%', overflow: 'auto' }}
            onScroll={onScroll}
          >
            {/*
              Full virtual canvas at the correct total height. Only a tiny
              subset of rows are rendered inside; they are absolutely
              positioned so the scroll thumb represents the true document size.
            */}
            <div
              style={{
                height: `${totalHeight()}px`,
                width: `${numColumns() * CELL_SIZE}px`,
                position: 'relative',
              }}
            >
              {/*
                Outer <For> — visible rows. keyed=true (default) so SolidJS
                tracks rows by their index value; scrolling in or out causes
                minimal DOM churn (add/remove rows at the edges).
              */}
              <For each={visibleRowIndices()}>
                {(rowIdx) => (
                  <div
                    style={{
                      position: 'absolute',
                      top: `${rowIdx() * CELL_SIZE}px`,
                      left: '0',
                      height: `${CELL_SIZE}px`,
                      display: 'flex',
                    }}
                  >
                    {/*
                      Inner <For> — columns within the row. keyed=true;
                      columnIndices only changes on window resize so this
                      reconciliation is rare.
                    */}
                    <For each={columnIndices()}>
                      {(colIdx) => {
                        const index = rowIdx() * numColumns() + colIdx();
                        if (index >= NUM_BOXES) return null;

                        // Stripe across documents so adjacent cells on
                        // screen spread write contention across rows.
                        const documentIdx = index % NUM_DOCUMENTS;
                        const arrayIdx = Math.floor(index / NUM_DOCUMENTS);

                        // These accessor functions are reactive — SolidJS
                        // tracks optimisticBoxesMap() as a dependency and
                        // re-runs the JSX expressions that call them whenever
                        // the map changes, updating only the specific DOM
                        // nodes that actually changed color.
                        const colorValue = () => {
                          const boxes = optimisticBoxesMap().get(documentIdx);
                          return boxes ? getColor(boxes, arrayIdx) : 0;
                        };
                        const isColored = () => colorValue() > 0;
                        const bg = () =>
                          isColored() ? PALETTE[colorValue()] : '#fff';
                        const border = () =>
                          isColored() ? PALETTE[colorValue()] : '#e5e7eb';

                        return (
                          <div style={{ padding: '1px' }}>
                            <div
                              onClick={() => toggle(documentIdx, arrayIdx)}
                              style={{
                                width: `${CELL_SIZE - 2}px`,
                                height: `${CELL_SIZE - 2}px`,
                                'background-color': bg(),
                                border: `1px solid ${border()}`,
                                'border-radius': '3px',
                                'box-sizing': 'border-box',
                                cursor: loading() ? 'default' : 'pointer',
                                transition: 'background-color 0.1s ease-out, border-color 0.1s ease-out',
                                display: 'flex',
                                'align-items': 'center',
                                'justify-content': 'center',
                                'font-size': '12px',
                                'line-height': '1',
                                color: '#fff',
                              }}
                            >
                              {isColored() ? '✓' : ''}
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
          </Show>
        </Loading>
      </div>
    </div>
  );
}
