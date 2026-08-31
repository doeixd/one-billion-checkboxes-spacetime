/**
 * Canvas renderer for the checkbox grid.
 *
 * The DOM renderer rebuilds every cell in the pool whenever `startRow` changes,
 * which — because the spacer is compressed ~10x — is very nearly every scroll
 * frame. That is thousands of class/style writes plus a full style recalc and
 * paint per frame, and it is what makes fast scrolling choppy.
 *
 * Here each cell is a `drawImage` of a pre-rendered sprite instead. The sprites
 * are built once per (palette, cell size, device pixel ratio), so painting a
 * full viewport is a few thousand blits with no layout and no style recalc.
 */

export interface CellSprites {
  /** Sprite per colour index, 0 (empty) through 15. */
  tiles: HTMLCanvasElement[];
  cellSize: number;
  dpr: number;
}

/** Repeating fill of the empty cell, used to lay the background in one call. */
let emptyPattern: CanvasPattern | null = null;
let emptyPatternTile: HTMLCanvasElement | null = null;

const BORDER_LIGHT = "#e5e7eb";
const CELL_PADDING = 1; // .cell-wrapper padding
const CORNER_RADIUS = 3; // .cell border-radius

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Pre-render one tile per palette entry, matching `.cell` / `.cell-filled`
 * in app.css. Returns null when 2D canvas is unavailable — callers fall back
 * to the DOM renderer.
 */
export function buildCellSprites(
  palette: string[],
  cellSize: number,
  dpr: number,
): CellSprites | null {
  const px = Math.max(1, Math.round(cellSize * dpr));
  const inset = CELL_PADDING * dpr;
  const inner = px - inset * 2;
  const tiles: HTMLCanvasElement[] = [];

  for (let color = 0; color < palette.length; color++) {
    const tile = document.createElement("canvas");
    tile.width = px;
    tile.height = px;
    const ctx = tile.getContext("2d");
    if (!ctx) return null;

    // Borders straddle the path, so inset by half a device pixel to stay crisp.
    const half = 0.5 * dpr;
    roundedRect(
      ctx,
      inset + half,
      inset + half,
      inner - dpr,
      inner - dpr,
      CORNER_RADIUS * dpr,
    );

    const filled = color > 0;
    ctx.fillStyle = filled ? palette[color] : "#fff";
    ctx.fill();
    ctx.lineWidth = dpr;
    ctx.strokeStyle = filled ? palette[color] : BORDER_LIGHT;
    ctx.stroke();

    if (filled) {
      ctx.fillStyle = "#fff";
      ctx.font = `${12 * dpr}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("✓", px / 2, px / 2);
    }

    tiles.push(tile);
  }

  return { tiles, cellSize, dpr };
}

export interface PaintGridOptions {
  ctx: CanvasRenderingContext2D;
  sprites: CellSprites;
  /** First grid row painted — the canvas top edge. */
  startRow: number;
  rows: number;
  cols: number;
  totalRows: number;
  numBoxes: number;
  numDocuments: number;
  /** Effective colour for a cell, pending overlay included. */
  getCellColor: (documentIdx: number, arrayIdx: number) => number;
}

/** Repaint the whole pool. Cheap enough to do wholesale — no dirty tracking. */
export function paintGrid(options: PaintGridOptions): void {
  const {
    ctx, sprites, startRow, rows, cols, totalRows, numBoxes, numDocuments, getCellColor,
  } = options;
  const { tiles, cellSize, dpr } = sprites;
  const px = cellSize * dpr;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cols * px, rows * px);

  // The board is overwhelmingly empty (tens of thousands coloured out of a
  // billion), so laying every cell down individually spends nearly all of its
  // time drawing blank tiles. Fill the empty grid in a single patterned
  // fillRect and blit only the cells that actually have colour — measured at
  // ~17ms -> ~0.1ms for a full viewport.
  if (emptyPatternTile !== tiles[0]) {
    emptyPattern = ctx.createPattern(tiles[0], "repeat");
    emptyPatternTile = tiles[0];
  }

  const paintedRows = Math.min(rows, Math.max(0, totalRows - startRow));

  if (emptyPattern) {
    ctx.fillStyle = emptyPattern;
    ctx.fillRect(0, 0, cols * px, paintedRows * px);
  }

  for (let localRow = 0; localRow < paintedRows; localRow++) {
    const rowBase = (startRow + localRow) * cols;
    const y = localRow * px;

    for (let col = 0; col < cols; col++) {
      const globalIndex = rowBase + col;
      // The last row is partial whenever cols does not divide NUM_BOXES.
      if (globalIndex >= numBoxes) {
        // Past the end of the board: clear the tail the pattern just filled.
        ctx.clearRect(col * px, y, (cols - col) * px, px);
        break;
      }

      const color = getCellColor(globalIndex % numDocuments, Math.floor(globalIndex / numDocuments));
      if (color === 0) continue; // already covered by the pattern fill
      ctx.drawImage(tiles[color] || tiles[0], col * px, y);
    }
  }
}
