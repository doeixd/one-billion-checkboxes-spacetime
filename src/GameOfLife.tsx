/**
 * Multiplayer Conway's Game of Life — 50x50 grid (2500 cells).
 *
 * Server-owned simulation ticks continuously. Clicking a cell sends a
 * server action that stamps a cross-shaped (+) seed pattern in the
 * player's identity-derived color. The simulation evolves from there.
 * All clients see the same board state — no local simulation.
 *
 * Data model:
 *   gol_grid       — authoritative full-board snapshot used during bootstrap.
 *   gol_sync       — board version + generation for sync handoff.
 *   gol_diff_log   — append-only versioned packed [x, y, color] live diffs.
 *
 * Rendering: each cell is a div with a CSS class (gol-c0..gol-c15) for
 * its color. Solid's fine-grained reactivity only touches cells whose
 * value changed — no style objects allocated per tick.
 */
import {
  createSignal,
  createStore,
  createEffect,
  createMemo,
  onSettled,
  For,
  Show,
  Loading,
} from "solid-js";
import { conn, isConnected } from "./main.tsx";
import { golBoardStream, type GolStreamPhase } from "./lib/gol-stream.ts";
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
  const [syncPhase, setSyncPhase] = createSignal<GolStreamPhase>("syncing");

  let resolveBoardReady!: () => void;
  let boardReadyResolved = false;
  const boardReadyPromise = new Promise<void>((resolve) => {
    resolveBoardReady = resolve;
  });

  const boardReady = createMemo(async () => {
    await boardReadyPromise;
    return true as const;
  });

  const applySnapshot = (data: Uint8Array) => {
    setCells((s: number[]) => {
      s.fill(0);
      for (let idx = 0; idx < CELL_COUNT; idx++) {
        const byte = data[idx >> 1] || 0;
        s[idx] = idx % 2 === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
      }
    });
  };

  const applyDiffData = (data: Uint8Array) => {
    if (data.length === 0) return;
    setCells((s: number[]) => {
      for (let i = 0; i + 2 < data.length; i += 3) {
        const idx = data[i + 1] * GOL_COLS + data[i];
        const color = data[i + 2];
        if (s[idx] !== color) s[idx] = color;
      }
    });
  };

  onSettled(() => {
    const onResize = () => setCellPx(calcCellSize());
    const abortController = new AbortController();

    window.addEventListener("resize", onResize);

    void (async () => {
      try {
        for await (const event of golBoardStream({
          conn,
          signal: abortController.signal,
        })) {
          switch (event.kind) {
            case "phase":
              setSyncPhase(event.phase);
              break;
            case "snapshot-ready":
              applySnapshot(event.cells);
              setGeneration(event.generation);
              if (!boardReadyResolved) {
                boardReadyResolved = true;
                resolveBoardReady();
              }
              break;
            case "diff":
              applyDiffData(event.data);
              break;
            case "sync":
              setGeneration(event.generation);
              break;
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("Game of Life stream failed:", error);
        }
      }
    })();

    return () => {
      abortController.abort();
      window.removeEventListener("resize", onResize);
    };
  });

  // ── Side effects ──────────────────────────────────────────────────
  createEffect(
    () => generation(),
    (gen) => {
      document.title = `Gen ${gen} — Game of Life`;
    },
  );

  // ── Interaction ───────────────────────────────────────────────────
  const isSyncing = () => syncPhase() !== "live";
  const loading = () => !isConnected() || isSyncing();

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
          {" · "}
          <a
            style={{ "text-decoration": "none", color: "#6b7280" }}
            href="https://github.com/doeixd/one-billion-checkboxes-spacetime"
            target="_blank"
          >
            Repo
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
        <Loading
          {...({ on: boardReady } as any)}
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
          <Show when={boardReady()}>
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
