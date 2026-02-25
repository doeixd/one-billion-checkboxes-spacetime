import { Grid } from 'react-window';
import { useMemo } from 'react';
import { useMeasure } from 'react-use';
import { tables, reducers } from './module_bindings';
import { useTable, useReducer, useSpacetimeDB } from 'spacetimedb/react';

const NUM_BOXES = 1_000_000;
const NUM_DOCUMENTS = 250;

function isChecked(boxes: number[], arrayIdx: number): boolean {
  const bit = arrayIdx % 8;
  const byteIdx = Math.floor(arrayIdx / 8);
  return !!((1 << bit) & (boxes[byteIdx] || 0));
}

type CellCustomProps = {
  boxesMap: Map<number, number[]>;
  numColumns: number;
  toggleReducer: (params: { documentIdx: number; arrayIdx: number; checked: boolean }) => void;
  loading: boolean;
};

function App() {
  const conn = useSpacetimeDB();
  const { isActive: connected } = conn;

  const [checkboxRows, isTableLoading] = useTable(tables.checkboxes);
  const toggleReducer = useReducer(reducers.toggle);

  // Build a map from idx to boxes for efficient lookup
  const boxesMap = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const row of checkboxRows) {
      map.set(row.idx, Array.from(row.boxes));
    }
    return map;
  }, [checkboxRows]);

  // Count checked boxes
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

  const [ref, { width, height }] = useMeasure<HTMLDivElement>();
  const numColumns = Math.ceil((width - 40) / 30);
  const numRows = Math.ceil(NUM_BOXES / numColumns);

  const loading = isTableLoading || !connected;

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
  const index = rowIndex * numColumns + columnIndex;

  if (index >= NUM_BOXES) return null;

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
