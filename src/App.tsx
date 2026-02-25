/**
 * Main UI — renders a virtual grid of 1,000,000 checkboxes.
 *
 * Data model:
 *   1M checkboxes are stored across 250 database rows ("documents").
 *   Each document holds 4,000 checkboxes as a bit-packed byte array (500 bytes).
 *   Checkbox N maps to: documentIdx = N % 250, arrayIdx = floor(N / 250).
 *
 * Real-time updates:
 *   useTable(tables.checkboxes) subscribes to all 250 rows over a single
 *   WebSocket. When any row changes (from this client or another), SpacetimeDB
 *   pushes the update and React re-renders the affected cells.
 *
 * Virtual scrolling:
 *   react-window's Grid only mounts the checkboxes visible in the viewport,
 *   so the DOM stays small even with 1M items.
 */
import { Grid } from 'react-window';
import { useMemo } from 'react';
import { useMeasure } from 'react-use';
import { tables, reducers } from './module_bindings';
import { useTable, useReducer, useSpacetimeDB } from 'spacetimedb/react';

const NUM_BOXES = 1_000_000;
const NUM_DOCUMENTS = 250;

/** Check if a specific bit is set in a byte array. */
function isChecked(boxes: number[], arrayIdx: number): boolean {
  const bit = arrayIdx % 8;
  const byteIdx = Math.floor(arrayIdx / 8);
  return !!((1 << bit) & (boxes[byteIdx] || 0));
}

/** Props passed from the Grid to every Cell via cellProps. */
type CellCustomProps = {
  boxesMap: Map<number, number[]>;
  numColumns: number;
  toggleReducer: (params: { documentIdx: number; arrayIdx: number; checked: boolean }) => void;
  loading: boolean;
};

function App() {
  const conn = useSpacetimeDB();
  const { isActive: connected } = conn;

  // Subscribe to the checkboxes table — returns all 250 rows in real-time
  const [checkboxRows, isTableLoading] = useTable(tables.checkboxes);
  // Get a callable handle to the server's toggle reducer
  const toggleReducer = useReducer(reducers.toggle);

  // Index rows by document idx for O(1) lookup in each Cell render
  const boxesMap = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const row of checkboxRows) {
      map.set(row.idx, Array.from(row.boxes));
    }
    return map;
  }, [checkboxRows]);

  // Popcount across all documents to display total checked
  const numCheckedBoxes = useMemo(() => {
    let count = 0;
    for (const boxes of boxesMap.values()) {
      for (const byte of boxes) {
        let b = byte;
        while (b) {
          count += b & 1;
          b >>= 1;
        }
      }
    }
    return count;
  }, [boxesMap]);

  // Measure the container so we can calculate how many columns fit
  const [ref, { width, height }] = useMeasure<HTMLDivElement>();
  const numColumns = Math.ceil((width - 40) / 30);
  const numRows = Math.ceil(NUM_BOXES / numColumns);

  const loading = isTableLoading || !connected;

  // Memoize cellProps so the Grid only re-renders cells when data changes
  const cellProps: CellCustomProps = useMemo(
    () => ({ boxesMap, numColumns, toggleReducer, loading }),
    [boxesMap, numColumns, toggleReducer, loading]
  );

  return (
    <div
      key={`${width}-${height}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        height: '95vh',
        width: '99vw',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
            One Million Checkboxes
          </div>
          <div>{loading ? 'Loading...' : `${numCheckedBoxes} boxes checked`}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <a
            style={{
              display: 'flex',
              alignItems: 'center',
              textDecoration: 'none',
              color: 'black',
            }}
            href="https://spacetimedb.com/?referral=gillkyle"
            target="_blank"
          >
            Powered by SpacetimeDB
          </a>
          <div style={{ marginLeft: 'auto' }}>
            source code on{' '}
            <a
              href="https://github.com/gillkyle/one-million-checkboxes-spacetime"
              target="_blank"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>
      <div style={{ width: '100%', height: '100%', flexGrow: 1 }} ref={ref}>
        <Grid<CellCustomProps>
          cellComponent={Cell}
          cellProps={cellProps}
          columnCount={numColumns}
          columnWidth={30}
          rowCount={numRows}
          rowHeight={30}
          style={{ height, width }}
        />
      </div>
    </div>
  );
}

/**
 * A single checkbox cell rendered by react-window.
 *
 * Converts the grid position (row, column) back to a flat index, then maps
 * that to a (documentIdx, arrayIdx) pair to look up the bit from the
 * in-memory boxesMap. Clicking calls the server's toggle reducer.
 */
const Cell = ({
  style,
  rowIndex,
  columnIndex,
  boxesMap,
  numColumns,
  toggleReducer,
  loading,
}: {
  ariaAttributes: { 'aria-colindex': number; role: 'gridcell' };
  style: React.CSSProperties;
  rowIndex: number;
  columnIndex: number;
} & CellCustomProps) => {
  // Flat index in the 0..999,999 range
  const index = rowIndex * numColumns + columnIndex;

  if (index >= NUM_BOXES) return null;

  // Reverse the mapping: checkboxes are striped across documents so that
  // adjacent checkboxes on screen live in different rows, spreading write
  // contention evenly across all 250 documents.
  const documentIdx = index % NUM_DOCUMENTS;
  const arrayIdx = Math.floor(index / NUM_DOCUMENTS);

  const boxes = boxesMap.get(documentIdx);
  const isCurrentlyChecked = boxes ? isChecked(boxes, arrayIdx) : false;
  const cellLoading = loading || !boxes;

  const onClick = () => {
    toggleReducer({ documentIdx, arrayIdx, checked: !isCurrentlyChecked });
  };

  return (
    <div style={style}>
      <input
        style={{
          margin: '0.25rem',
          cursor: cellLoading ? undefined : 'pointer',
          width: '24px',
          height: '24px',
          padding: '8px',
        }}
        type="checkbox"
        checked={isCurrentlyChecked}
        disabled={cellLoading}
        onChange={onClick}
      />
    </div>
  );
};

export default App;
