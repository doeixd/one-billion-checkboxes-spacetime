/**
 * Multiplayer Conway's Game of Life — 50x50 grid (2500 cells).
 *
 * Server-owned simulation ticks continuously. Clicking a cell sends a
 * server action that stamps a cross-shaped (+) seed pattern in the
 * player's identity-derived color. The simulation evolves from there.
 * All clients see the same board state — no local simulation.
 *
 * Data model:
 *   gol_diff       — single row; packed [x, y, color] cell diffs per tick.
 *   gol_row_chunk  — 50 rows × 25 bytes nibble-packed; initial state for
 *                    new clients + periodic snapshots (every ~50 ticks).
 *   gol_meta       — single row; generation counter updated every tick.
 *
 * Rendering: each cell is a div with a CSS class (gol-c0..gol-c15) for
 * its color. Solid's fine-grained reactivity only touches cells whose
 * value changed — no style objects allocated per tick.
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
import { conn, isConnected } from "./main.tsx";
import type { EventContext } from "./module_bindings/index.ts";
import type { GolRowChunk, GolMeta, GolDiff } from "./module_bindings/types.ts";
import "./gol.css";

const GOL_COLS = 50;
const GOL_ROWS = 50;
const CELL_COUNT = GOL_COLS * GOL_ROWS;

const indices = Array.from({ length: CELL_COUNT }, (_, i) => i);

// Pre-built class name strings — no allocation on lookup.
const CELL_CLASSES: string[] = Array.from({ length: 16 }, (_, i) => `gol-cell gol-c${i}`);

/** Compute cell size to fit the grid within the viewport with some padding. */
function calcCellSize() {
  const pad = 24; // padding on each side
  const headerH = 50;
  const maxW = (window.innerWidth - pad * 2) / (GOL_COLS + 1); // +1 for gaps
  const maxH = (window.innerHeight - headerH - pad * 2) / (GOL_ROWS + 1);
  return Math.max(4, Math.floor(Math.min(maxW, maxH)));
}

export default function GameOfLife() {
  const [cells, setCells] = createStore<number[]>(new Array(CELL_COUNT).fill(0));
  const [generation, setGeneration] = createSignal(0n);
  const [cellPx, setCellPx] = createSignal(calcCellSize());

  // Recalculate on resize
  const onResize = () => setCellPx(calcCellSize());
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));

  // ── Async subscription readiness (Solid 2.0 Loading pattern) ──────
  let resolveSubscription!: () => void;
  const subscriptionPromise = new Promise<void>((res) => {
    resolveSubscription = res;
  });

  const gridReady = createMemo(async () => {
    await subscriptionPromise;
    return true as const;
  });

  const isSyncing = () => isPending(() => gridReady());

  // ── Setup: subscribe to GOL tables ────────────────────────────────
  // Pre-allocated decode buffer — reused every chunk.
  const _decodeBuf = new Uint8Array(GOL_COLS);

  onSettled(() => {
    // Row chunks: used for initial snapshot (and periodic syncs for late joiners).
    const handleChunk = (chunk: GolRowChunk) => {
      const base = chunk.rowIdx * GOL_COLS;
      const bytes = chunk.cells as Uint8Array;
      for (let x = 0; x < GOL_COLS; x++) {
        const byteIdx = x >> 1;
        const byte = bytes[byteIdx] || 0;
        _decodeBuf[x] = x % 2 === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
      }
      setCells((s: number[]) => {
        for (let x = 0; x < GOL_COLS; x++) {
          const val = _decodeBuf[x];
          if (s[base + x] !== val) s[base + x] = val;
        }
      });
    };

    conn.db.golRowChunk.onInsert((_ctx: EventContext, row: GolRowChunk) =>
      handleChunk(row),
    );
    conn.db.golRowChunk.onUpdate((_ctx: EventContext, _old: GolRowChunk, row: GolRowChunk) =>
      handleChunk(row),
    );

    // Diff: packed [x, y, color, ...] triples — one message per tick.
    const handleDiff = (diff: GolDiff) => {
      const data = diff.data as Uint8Array;
      if (data.length === 0) return;
      setCells((s: number[]) => {
        for (let i = 0; i + 2 < data.length; i += 3) {
          const idx = data[i + 1] * GOL_COLS + data[i]; // y * cols + x
          const color = data[i + 2];
          if (s[idx] !== color) s[idx] = color;
        }
      });
    };

    conn.db.golDiff.onInsert((_ctx: EventContext, row: GolDiff) =>
      handleDiff(row),
    );
    conn.db.golDiff.onUpdate((_ctx: EventContext, _old: GolDiff, row: GolDiff) =>
      handleDiff(row),
    );

    // Meta: generation counter.
    conn.db.golMeta.onInsert((_ctx: EventContext, row: GolMeta) =>
      setGeneration(row.generation),
    );
    conn.db.golMeta.onUpdate((_ctx: EventContext, _old: GolMeta, row: GolMeta) =>
      setGeneration(row.generation),
    );

    conn.subscriptionBuilder()
      .onApplied(() => resolveSubscription())
      .subscribe([
        "SELECT * FROM gol_row_chunk",
        "SELECT * FROM gol_diff",
        "SELECT * FROM gol_meta",
      ]);
  });

  // ── Side effects ──────────────────────────────────────────────────
  createEffect(
    () => generation(),
    (gen) => {
      document.title = `Gen ${gen} — Game of Life`;
    },
  );

  // ── Interaction ───────────────────────────────────────────────────
  const loading = () => !isConnected() || !gridReady();

  const tapCell = (x: number, y: number) => {
    if (loading()) return;
    conn.reducers.golTapCell({ x, y });
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100vh",
        width: "100vw",
        "background-color": "#0f0f23",
        color: "#ccc",
        "font-family": "system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          padding: "8px 12px",
          "border-bottom": "1px solid #333",
          "flex-shrink": "0",
          gap: "12px",
          "flex-wrap": "wrap",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <a
            href="/"
            style={{
              color: "#6b7280",
              "text-decoration": "none",
              "font-size": "0.8rem",
            }}
          >
            &larr; Checkboxes
          </a>
          <span
            style={{
              "font-weight": "700",
              "font-size": "1rem",
              color: "#e5e7eb",
            }}
          >
            Game of Life
          </span>
          <Show when={isSyncing()}>
            <span
              aria-label="Connecting…"
              style={{
                display: "inline-block",
                width: "10px",
                height: "10px",
                border: "2px solid #333",
                "border-top-color": "#6b7280",
                "border-radius": "50%",
                animation: "spin 0.75s linear infinite",
                "flex-shrink": "0",
              }}
            />
          </Show>
          <span style={{ "font-size": "0.8rem", color: "#6b7280" }}>
            Gen {generation().toString()}
          </span>
        </div>

        <div style={{ "font-size": "0.75rem", color: "#6b7280" }}>
          <a
            style={{ "text-decoration": "none", color: "#6b7280" }}
            href="https://spacetimedb.com/?referral=gillkyle"
            target="_blank"
          >
            Powered by SpacetimeDB
          </a>
          {" and "}
          <a
            style={{ "text-decoration": "none", color: "#6b7280" }}
            href="https://github.com/solidjs/solid/discussions/2596"
            target="_blank"
          >
            Solid 2.0
          </a>
        </div>
      </div>

      {/* Grid */}
      <div
        style={{
          "flex-grow": "1",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          overflow: "auto",
        }}
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
                gap: "10px",
                color: "#6b7280",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: "28px",
                  height: "28px",
                  border: "3px solid #333",
                  "border-top-color": "#6b7280",
                  "border-radius": "50%",
                  animation: "spin 0.75s linear infinite",
                }}
              />
              <span style={{ "font-size": "0.875rem" }}>
                {isConnected()
                  ? "Loading grid…"
                  : "Connecting to SpacetimeDB…"}
              </span>
            </div>
          }
        >
          <Show when={gridReady()}>
            <div
              class="gol-grid"
              style={{ "--cell-px": `${cellPx()}px` }}
            >
              <For each={indices} keyed={false}>
                {(idxAccessor) => (
                  <div
                    class={CELL_CLASSES[cells[idxAccessor()]] || CELL_CLASSES[0]}
                    onPointerDown={(e: PointerEvent) => {
                      e.preventDefault();
                      const i = idxAccessor();
                      tapCell(i % GOL_COLS, (i / GOL_COLS) | 0);
                    }}
                  />
                )}
              </For>
            </div>
          </Show>
        </Loading>
      </div>
    </div>
  );
}
