/**
 * Main UI — renders a virtual grid of 1,000,000,000 checkboxes.
 *
 * Data model:
 *   1B checkboxes are stored lazily across up to 250,000 database rows ("documents").
 *   Each document holds 4,000 checkboxes packed as nibbles (4 bits each, 2 per byte).
 *   Nibble 0 = unchecked; 1-15 = color index. Missing rows are treated as all-zero.
 *   Checkbox N maps to: documentIdx = N % 250000, arrayIdx = floor(N / 250000).
 *
 * Real-time updates:
 *   useTable(tables.checkboxes) subscribes to all created rows over a single
 *   WebSocket. Only touched document rows exist; the rest are implicitly unchecked.
 *
 * Virtual scrolling:
 *   react-window's Grid only mounts the checkboxes visible in the viewport,
 *   so the DOM stays small regardless of total checkbox count.
 */
import { Grid } from 'react-window';
import { useMemo, useState } from 'react';
import { useMeasure } from 'react-use';
import { tables, reducers } from './module_bindings';
import { useTable, useReducer, useSpacetimeDB } from 'spacetimedb/react';

const NUM_BOXES = 1_000_000_000;
const NUM_DOCUMENTS = 250_000;
const CELL_SIZE = 12; // px — small enough to pack many on screen

/**
 * 16-color palette: index 0 = "clear/uncheck", indices 1-15 = colors.
 * Presented in the UI as 16 swatches (the clear swatch shows an ✕).
 */
const PALETTE: string[] = [
  '#f3f4f6', // 0: clear / uncheck (light gray background)
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

/** Reads the 4-bit nibble color for checkbox `arrayIdx` from a byte array. */
function getColor(boxes: number[], arrayIdx: number): number {
  const byteIdx = Math.floor(arrayIdx / 2);
  const byte = boxes[byteIdx] || 0;
  return arrayIdx % 2 === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
}

/** Props passed from the Grid to every Cell via cellProps. */
type CellCustomProps = {
  boxesMap: Map<number, number[]>;
  numColumns: number;
  toggleReducer: (params: { documentIdx: number; arrayIdx: number; color: number }) => void;
  selectedColor: number;
  loading: boolean;
};

function App() {
  const conn = useSpacetimeDB();
  const { isActive: connected } = conn;

  // Subscribe to the checkboxes table — returns all created document rows in real-time
  const [checkboxRows, isTableLoading] = useTable(tables.checkboxes);
  // Get a callable handle to the server's toggle reducer
  const toggleReducer = useReducer(reducers.toggle);

  // Currently selected color (0 = clear/uncheck, 1-15 = color index)
  const [selectedColor, setSelectedColor] = useState(1);

  // Index rows by document idx for O(1) lookup in each Cell render
  const boxesMap = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const row of checkboxRows) {
      map.set(row.idx, Array.from(row.boxes));
    }
    return map;
  }, [checkboxRows]);

  // Count colored (non-zero nibble) checkboxes across all loaded documents
  const numCheckedBoxes = useMemo(() => {
    let count = 0;
    for (const boxes of boxesMap.values()) {
      for (const byte of boxes) {
        if (byte === 0) continue;
        if (byte & 0x0F) count++;
        if (byte >> 4) count++;
      }
    }
    return count;
  }, [boxesMap]);

  // Measure the container so we can calculate how many columns fit
  const [ref, { width, height }] = useMeasure<HTMLDivElement>();
  const numColumns = Math.max(1, Math.floor(width / CELL_SIZE));
  const numRows = Math.ceil(NUM_BOXES / numColumns);

  const loading = isTableLoading || !connected;

  // Memoize cellProps so the Grid only re-renders cells when data changes
  const cellProps: CellCustomProps = useMemo(
    () => ({ boxesMap, numColumns, toggleReducer, selectedColor, loading }),
    [boxesMap, numColumns, toggleReducer, selectedColor, loading]
  );

  return (
    <div
      key={`${width}-${height}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        boxSizing: 'border-box',
        overflow: 'hidden',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid #e5e7eb',
          background: '#fff',
          flexShrink: 0,
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem' }}>One Billion Checkboxes</div>
          <div style={{ color: '#6b7280', fontSize: '0.8rem', marginTop: '2px' }}>
            {loading ? 'Connecting…' : `${numCheckedBoxes.toLocaleString()} colored`}
          </div>
        </div>

        {/* Color palette */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>Color:</span>
          <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
            {PALETTE.map((color, i) => (
              <button
                key={i}
                onClick={() => setSelectedColor(i)}
                title={i === 0 ? 'Clear (uncheck)' : `Color ${i}`}
                style={{
                  width: '20px',
                  height: '20px',
                  backgroundColor: i === 0 ? '#fff' : color,
                  border: selectedColor === i
                    ? '2px solid #1f2937'
                    : '1px solid #d1d5db',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: '9px',
                  color: '#374151',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {i === 0 ? '✕' : ''}
              </button>
            ))}
          </div>
        </div>

        <div style={{ fontSize: '0.75rem', color: '#9ca3af', textAlign: 'right' }}>
          <a
            style={{ textDecoration: 'none', color: '#6b7280' }}
            href="https://spacetimedb.com/?referral=gillkyle"
            target="_blank"
          >
            Powered by SpacetimeDB
          </a>
        </div>
      </div>

      {/* Grid */}
      <div style={{ flexGrow: 1, overflow: 'hidden' }} ref={ref}>
        <Grid<CellCustomProps>
          cellComponent={Cell}
          cellProps={cellProps}
          columnCount={numColumns}
          columnWidth={CELL_SIZE}
          rowCount={numRows}
          rowHeight={CELL_SIZE}
          style={{ height, width }}
        />
      </div>
    </div>
  );
}

/**
 * A single colored cell rendered by react-window.
 *
 * Converts the grid position to a flat index, maps that to a
 * (documentIdx, arrayIdx) pair, reads the nibble color from boxesMap,
 * and renders a tiny colored square. Clicking cycles through the
 * selected color or clears the cell.
 */
const Cell = ({
  style,
  rowIndex,
  columnIndex,
  boxesMap,
  numColumns,
  toggleReducer,
  selectedColor,
  loading,
}: {
  ariaAttributes: { 'aria-colindex': number; role: 'gridcell' };
  style: React.CSSProperties;
  rowIndex: number;
  columnIndex: number;
} & CellCustomProps) => {
  // Flat index in the 0..999,999,999 range
  const index = rowIndex * numColumns + columnIndex;
  if (index >= NUM_BOXES) return null;

  // Stripe across documents: adjacent cells on screen map to different rows,
  // spreading write contention evenly.
  const documentIdx = index % NUM_DOCUMENTS;
  const arrayIdx = Math.floor(index / NUM_DOCUMENTS);

  const boxes = boxesMap.get(documentIdx);
  const colorValue = boxes ? getColor(boxes, arrayIdx) : 0;

  const onClick = () => {
    if (loading) return;
    // Clicking a cell that already has the selected color clears it; otherwise applies it.
    const newColor = colorValue === selectedColor && selectedColor !== 0 ? 0 : selectedColor;
    toggleReducer({ documentIdx, arrayIdx, color: newColor });
  };

  const isColored = colorValue > 0;
  const bg = isColored ? PALETTE[colorValue] : '#fff';
  const border = isColored ? PALETTE[colorValue] : '#e5e7eb';

  return (
    <div style={{ ...style, padding: '1px' }}>
      <div
        onClick={onClick}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: bg,
          border: `1px solid ${border}`,
          borderRadius: '1px',
          boxSizing: 'border-box',
          cursor: loading ? 'default' : 'pointer',
        }}
      />
    </div>
  );
};

export default App;
