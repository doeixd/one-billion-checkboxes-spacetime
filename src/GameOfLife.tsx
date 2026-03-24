/**
 * Multiplayer Conway's Game of Life — 50x50 grid (2500 cells).
 *
 * Server-owned simulation ticks continuously. Clicking a cell sends a
 * server action that stamps a cross-shaped (+) seed pattern in the
 * player's identity-derived color. The simulation evolves from there.
 * All clients see the same board state — no local simulation.
 */
import {
  createSignal,
  createStore,
  createMemo,
  createEffect,
  isPending,
  onSettled,
  For,
  Show,
  Loading,
} from "solid-js";
import { conn, isConnected, navigate } from "./main.tsx";
import type { EventContext } from "./module_bindings/index.ts";
import type { GolGrid } from "./module_bindings/types.ts";

const GOL_COLS = 50;
const GOL_ROWS = 50;
const CELL_COUNT = GOL_COLS * GOL_ROWS;
const CELL_PX = 12;

const indices = Array.from({ length: CELL_COUNT }, (_, i) => i);

const DEAD_COLOR = "#16162a";

/** Colors for live cell payloads 1-15 (same palette as checkboxes). */
const LIFE_PALETTE: string[] = [
  DEAD_COLOR,  // 0: dead
  "#111827",   // 1: near-black
  "#dc2626",   // 2: red
  "#ea580c",   // 3: orange
  "#d97706",   // 4: amber
  "#16a34a",   // 5: green
  "#0891b2",   // 6: cyan
  "#2563eb",   // 7: blue
  "#7c3aed",   // 8: purple
  "#db2777",   // 9: pink
  "#f87171",   // 10: light red
  "#fb923c",   // 11: light orange
  "#fbbf24",   // 12: yellow
  "#4ade80",   // 13: light green
  "#38bdf8",   // 14: sky blue
  "#a78bfa",   // 15: lavender
];

export default function GameOfLife() {
  const [cells, setCells] = createStore<number[]>(new Array(CELL_COUNT).fill(0));
  const [generation, setGeneration] = createSignal(0n);

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

  // ── Setup: subscribe to GOL grid ──────────────────────────────────
  onSettled(() => {
    const upsert = (row: GolGrid) => {
      const bytes = row.cells as Uint8Array;
      setCells((s: number[]) => {
        for (let i = 0; i < CELL_COUNT; i++) {
          s[i] = bytes[i] || 0;
        }
      });
      setGeneration(row.generation);
    };

    conn.db.golGrid.onInsert((_ctx: EventContext, row: GolGrid) => upsert(row));
    conn.db.golGrid.onUpdate((_ctx: EventContext, _old: GolGrid, row: GolGrid) => upsert(row));

    conn.subscriptionBuilder()
      .onApplied(() => resolveSubscription())
      .subscribe("SELECT * FROM gol_grid");
  });

  // ── Side effects (split createEffect: compute → apply) ───────────
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
            onClick={(e: MouseEvent) => {
              e.preventDefault();
              navigate("/");
            }}
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
              style={{
                display: "grid",
                "grid-template-columns": `repeat(${GOL_COLS}, ${CELL_PX}px)`,
                gap: "1px",
                "background-color": "#1a1a2e",
                padding: "1px",
                "user-select": "none",
                "border-radius": "4px",
              }}
            >
              <For each={indices} keyed={false}>
                {(idxAccessor) => {
                  const x = () => idxAccessor() % GOL_COLS;
                  const y = () => Math.floor(idxAccessor() / GOL_COLS);
                  const cellVal = () => cells[idxAccessor()];
                  return (
                    <div
                      onPointerDown={(e: PointerEvent) => {
                        e.preventDefault();
                        tapCell(x(), y());
                      }}
                      style={{
                        width: `${CELL_PX}px`,
                        height: `${CELL_PX}px`,
                        "background-color": LIFE_PALETTE[cellVal()] || DEAD_COLOR,
                        cursor: "pointer",
                        transition: "background-color 0.1s",
                      }}
                    />
                  );
                }}
              </For>
            </div>
          </Show>
        </Loading>
      </div>
    </div>
  );
}
