/**
 * Multiplayer Conway's Game of Life — 50x50 grid (2500 cells).
 *
 * Server-owned simulation ticks continuously. Clicking a cell sends a
 * server action that stamps a cross-shaped (+) seed pattern in the
 * player's identity-derived color. The simulation evolves from there.
 * All clients see the same board state — no local simulation.
 *
 * Data model:
 *   gol_row_chunk  — current row snapshots used during bootstrap.
 *   gol_sync       — board version + generation for sync handoff.
 *   gol_diff_v2    — versioned packed [x, y, color] live diffs.
 *
 * Rendering: each cell is a div with a CSS class (gol-c0..gol-c15) for
 * its color. Solid's fine-grained reactivity only touches cells whose
 * value changed — no style objects allocated per tick.
 */
import {
  createSignal,
  createStore,
  createEffect,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { conn, isConnected } from "./main.tsx";
import type { EventContext, SubscriptionHandle } from "./module_bindings/index.ts";
import type { GolRowChunk, GolSync, GolDiffV2, GolLoopStatus } from "./module_bindings/types.ts";
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
  const [loopPeriod, setLoopPeriod] = createSignal(0);
  const [cellPx, setCellPx] = createSignal(calcCellSize());
  const [isSyncing, setIsSyncing] = createSignal(true);

  // Recalculate on resize
  const onResize = () => setCellPx(calcCellSize());
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));

  // ── Setup: bootstrap from gol_row_chunk, then switch to gol_diff ──
  const snapshotRows = new Map<number, Uint8Array>();
  let phase1Handle: SubscriptionHandle | null = null;
  let phase2Handle: SubscriptionHandle | null = null;
  let phase2Live = false;
  let subGeneration = 0;
  let disposed = false;
  let latestVersion = 0n;
  let lastAppliedVersion = 0n;

  const resetSyncState = () => {
    snapshotRows.clear();
    latestVersion = 0n;
    lastAppliedVersion = 0n;
    phase2Live = false;
    setIsSyncing(true);
  };

  const applySnapshot = () => {
    setCells((s: number[]) => {
      s.fill(0);
      for (const [rowIdx, bytes] of snapshotRows) {
        const base = rowIdx * GOL_COLS;
        for (let x = 0; x < GOL_COLS; x++) {
          const byteIdx = x >> 1;
          const byte = bytes[byteIdx] || 0;
          s[base + x] = x % 2 === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
        }
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

  const safeUnsub = (handle: SubscriptionHandle | null) => {
    try {
      handle?.unsubscribe();
    } catch {}
  };

  const startSubscriptions = () => {
    if (disposed) return;
    safeUnsub(phase1Handle);
    safeUnsub(phase2Handle);
    resetSyncState();
    const gen = ++subGeneration;

    const p1Handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (disposed || gen !== subGeneration) {
          safeUnsub(p1Handle);
          return;
        }

        applySnapshot();

        phase2Handle = conn
          .subscriptionBuilder()
          .onApplied(() => {
            if (disposed || gen !== subGeneration) return;
            phase2Live = true;
            lastAppliedVersion = latestVersion;
            setIsSyncing(false);
            safeUnsub(p1Handle);
            if (phase1Handle === p1Handle) phase1Handle = null;
          })
          .subscribe([
            "SELECT * FROM gol_diff_v2",
            "SELECT * FROM gol_sync",
            "SELECT * FROM gol_loop_status",
          ]);
      })
      .subscribe([
        "SELECT * FROM gol_row_chunk",
        "SELECT * FROM gol_sync",
        "SELECT * FROM gol_loop_status",
      ]);

    phase1Handle = p1Handle;
  };

  onCleanup(() => {
    disposed = true;
    safeUnsub(phase1Handle);
    safeUnsub(phase2Handle);
    conn.db.golRowChunk.removeOnInsert(handleChunkInsert);
    conn.db.golRowChunk.removeOnUpdate(handleChunkUpdate);
    conn.db.golDiffV2.removeOnInsert(handleDiffInsert);
    conn.db.golDiffV2.removeOnUpdate(handleDiffUpdate);
    conn.db.golSync.removeOnInsert(handleSyncInsert);
    conn.db.golSync.removeOnUpdate(handleSyncUpdate);
    conn.db.golLoopStatus.removeOnInsert(handleLoopInsert);
    conn.db.golLoopStatus.removeOnUpdate(handleLoopUpdate);
  });

  const handleChunk = (row: GolRowChunk) => {
    if (disposed) return;
    snapshotRows.set(row.rowIdx, new Uint8Array(row.cells as Uint8Array));
    if (!phase2Live) applySnapshot();
  };

  const handleChunkInsert = (_ctx: EventContext, row: GolRowChunk) => handleChunk(row);
  const handleChunkUpdate = (_ctx: EventContext, _old: GolRowChunk, row: GolRowChunk) => handleChunk(row);

  conn.db.golRowChunk.onInsert(handleChunkInsert);
  conn.db.golRowChunk.onUpdate(handleChunkUpdate);

  const maybeApplyDiff = (row: GolDiffV2) => {
    if (disposed || !phase2Live) return;
    if (row.version <= lastAppliedVersion) return;
    if (row.version !== lastAppliedVersion + 1n) {
      startSubscriptions();
      return;
    }
    applyDiffData(row.data as Uint8Array);
    lastAppliedVersion = row.version;
  };
  const handleDiffInsert = (_ctx: EventContext, row: GolDiffV2) => maybeApplyDiff(row);
  const handleDiffUpdate = (_ctx: EventContext, _old: GolDiffV2, row: GolDiffV2) => maybeApplyDiff(row);
  conn.db.golDiffV2.onInsert(handleDiffInsert);
  conn.db.golDiffV2.onUpdate(handleDiffUpdate);

  const handleSync = (row: GolSync) => {
    latestVersion = row.version;
    setGeneration(row.generation);
  };
  const handleSyncInsert = (_ctx: EventContext, row: GolSync) => {
    if (disposed) return;
    handleSync(row);
  };
  const handleSyncUpdate = (_ctx: EventContext, _old: GolSync, row: GolSync) => {
    if (disposed) return;
    handleSync(row);
  };
  conn.db.golSync.onInsert(handleSyncInsert);
  conn.db.golSync.onUpdate(handleSyncUpdate);

  // Loop detection status
  const handleLoop = (row: GolLoopStatus) => setLoopPeriod(row.loopPeriod);
  const handleLoopInsert = (_ctx: EventContext, row: GolLoopStatus) => {
    if (disposed) return;
    handleLoop(row);
  };
  const handleLoopUpdate = (_ctx: EventContext, _old: GolLoopStatus, row: GolLoopStatus) => {
    if (disposed) return;
    handleLoop(row);
  };
  conn.db.golLoopStatus.onInsert(handleLoopInsert);
  conn.db.golLoopStatus.onUpdate(handleLoopUpdate);

  queueMicrotask(() => {
    startSubscriptions();
  });

  // ── Side effects ──────────────────────────────────────────────────
  createEffect(
    () => generation(),
    (gen) => {
      document.title = `Gen ${gen} — Game of Life`;
    },
  );

  // ── Interaction ───────────────────────────────────────────────────
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
          <Show when={loopPeriod() > 0}>
            <span style={{
              "font-size": "0.75rem",
              color: "#d97706",
              "font-weight": "600",
            }}>
              {`Loop (period ${loopPeriod()}) — tap the board to resume`}
            </span>
          </Show>
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
        <Show
          when={!isSyncing()}
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
      </div>
    </div>
  );
}
