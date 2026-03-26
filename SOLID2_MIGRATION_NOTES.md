# Solid 2.0 Migration Notes

Short reference for future Solid 1.x -> 2.0 migration work in this repo.

## Biggest breaking changes

- Imports moved:
  - `solid-js/web` -> `@solidjs/web`
  - `solid-js/store` -> `solid-js`
  - `solid-js/h` -> `@solidjs/h`
  - `solid-js/html` -> `@solidjs/html`
  - `solid-js/universal` -> `@solidjs/universal`
- Updates are microtask-batched by default. After a setter, reads still return the old committed value until the batch flushes. Use `flush()` only when synchronous settling is required.
- `createEffect` is split into compute/apply phases: `createEffect(source, apply)`. Cleanup usually comes from the apply callback's return value.
- `onMount` is replaced by `onSettled`.
- Async reads no longer use `createResource`; prefer async computations such as `createMemo(() => fetchThing(id()))` and wrap consumers in `<Loading>`.
- `Suspense` -> `Loading`, `ErrorBoundary` -> `Errored`.
- `Index` is removed. Use `<For keyed={false}>`.
- `For`, `Show`, and some other control-flow function children now pass accessors. Call them: `item()`, `i()`, `u()`.

## Reactivity rules to watch for

- Top-level reactive reads in component bodies now warn in dev. Do not destructure reactive props at the function boundary. Read inside JSX, a memo/effect, or `untrack(...)` if intentionally one-time.
- Writing signals/stores inside reactive scopes also warns. Prefer:
  - `createMemo` for derivation
  - event handlers or actions for writes
  - cleanup returned from effect apply callbacks
- `batch()` is removed. Use the default microtask behavior or `flush()` when immediate DOM/state visibility is necessary.

## Stores and helpers

- Prefer draft-style store setters:

```ts
setStore(s => {
  s.user.address.city = "Paris";
});
```

- `storePath(...)` exists only as an opt-in compatibility helper for old path-style setters.
- `unwrap(store)` -> `snapshot(store)` for plain non-reactive values.
- `mergeProps(...)` -> `merge(...)`.
- `splitProps(...)` -> `omit(...)`.
- `undefined` now overrides when using `merge`; it is not skipped.
- New derived forms exist:
  - `createSignal(fn)` for writable derived signals
  - `createStore(fn, initial)` for derived stores
  - `createProjection` is the replacement direction for many `createSelector` patterns

## Async and mutation model

- Use `<Loading fallback={...}>` for initial async readiness.
- Use `isPending(() => expr)` for stale-while-revalidating UI, not initial loading.
- Use `latest(fn)` to peek at in-flight values during transitions.
- Solid 2.0 async computations can return not just Promises, but also `AsyncIterable`s. That makes "stream" style state a first-class fit for reactive reads.
- Use `refresh(x)` or `refresh(() => expr)` to recompute derived async reads after writes.
- Prefer `action(...)` plus `createOptimistic(...)` / `createOptimisticStore(...)` for optimistic mutations.
- `startTransition` and `useTransition` are removed; transitions are built in.

## Async iterator ideas for subscriptions

- Solid 2.0 docs explicitly say computations may return `Promise`s or `AsyncIterable`s. For this repo, that suggests modeling SpacetimeDB subscriptions as streams instead of manually wiring every phase through local mutable flags.
- Important caveat: beta docs describe the capability clearly, but some exact ergonomics may still evolve. Treat the patterns below as design directions, not drop-in API guarantees.

### Why this fits this repo

- The app already has stream-shaped data:
  - checkbox bootstrap -> live diff handoff in `src/App.tsx`
  - Game of Life snapshot -> versioned diff handoff in `src/GameOfLife.tsx`
  - always-on event feeds via `conn.db.*.onInsert` / `onUpdate`
- Today those flows are managed manually with:
  - `SubscriptionHandle` lifetimes
  - generation counters
  - `resolveSubscription()` promises
  - separate "phase 1 / phase 2" local variables
- Async iterators could make those flows read more like "subscribe, yield initial state, then yield diffs forever".

### Pattern idea: wrap a subscription as an async generator

```ts
async function* checkboxRangeStream(range: Range) {
  const snapshot = await loadInitialRange(range);
  yield { type: "snapshot", snapshot };

  for await (const change of checkboxDiffEvents(range)) {
    yield { type: "diff", change };
  }
}
```

- Then a derived Solid computation could consume that stream as the source of truth for a viewport, instead of resolving one promise for readiness and separately wiring event handlers.
- Conceptually: first yield establishes readiness for `<Loading>`, later yields drive incremental updates without inventing a separate `createResource` or ad hoc loading flags.

### Pattern idea: viewport-scoped stream per visible range

- Current checkbox grid logic in `src/App.tsx` computes `visibleDocRange()` and resubscribes when edges move outside the current range.
- A Solid 2.0 version could derive a stream from the current range:
  - compute current visible range
  - create an async iterable tied to that range
  - let Solid suspend initial render through `<Loading>`
  - show `isPending(() => viewportStream())` while switching ranges in the background
- This is especially attractive because the project already uses viewport-scoped subscriptions as a core performance trick.

### Pattern idea: unify snapshot + diff handoff for Game of Life

- `src/GameOfLife.tsx` already has a perfect streaming shape:
  - subscribe to `gol_row_chunk`
  - apply bootstrap snapshot
  - switch to `gol_diff_v2`
  - restart if version continuity breaks
- That could be represented as one async generator that yields:
  - `snapshot rows`
  - `live diff packets`
  - `resync requested`
- This would make the recovery path more explicit and easier to test than scattered `phase2Live`, `latestVersion`, and `lastAppliedVersion` flags.

### Pattern idea: stream connection lifecycle into UI

- `src/main.tsx` currently exposes `isConnected` as a module-level signal and reloads on visibility regain after disconnect.
- A richer async stream could yield connection states like `connecting`, `connected`, `reconnecting`, `disconnected`, `resynching`.
- That would make the UI more demonstrably "Solid 2 native async" than plain booleans and let `Loading` / `isPending` reflect real connection phases.

### Pattern idea: event log projections

- `checkbox_changes` and `gol_diff_v2` are already event-log style tables.
- Async iterators plus derived stores suggest a nice model:
  - stream events from SpacetimeDB
  - fold them into a draft store with `createStore(fn)` / projection-style logic
  - expose a plain accessor to the current projected state
- This would showcase Solid 2.0 as a natural consumer of append-only or diff-based backend feeds.

### Pattern idea: actions for subscription-driven mutations

- Toggling checkboxes is still manual optimistic state today in `src/App.tsx` via `pendingStore`, `pendingCountDelta`, and inflight maps.
- A stronger Solid 2.0 showcase would be:
  - `action(...)` for toggle submissions
  - `createOptimisticStore(...)` for local overlay state
  - `refresh(...)` or stream invalidation when authoritative server updates arrive
- Even if SpacetimeDB subscriptions remain event-driven under the hood, the mutation UX could better match Solid 2's new async story.

## Repo-specific observations

- This repo is already using several real Solid 2.0 APIs directly:
  - `@solidjs/web` import in `src/main.tsx`
  - `Loading`, `isPending`, and `onSettled` in `src/App.tsx`
  - split `createEffect(source, apply)` in `src/App.tsx` and `src/GameOfLife.tsx`
  - `<For keyed={false}>` in `src/App.tsx`
- The current architecture is strongly aligned with Solid 2.0's strengths:
  - fixed DOM pool + accessor-driven cells
  - async first-render boundary for subscription readiness
  - fine-grained updates from nibble-level diffs
- The biggest remaining Solid 2.0 showcase gaps are not migration blockers; they are "could be more native" opportunities:
  - manual subscription orchestration instead of async iterable computations
  - manual optimistic state instead of `action` / `createOptimisticStore`
  - booleans and ad hoc promises where richer async state boundaries could be modeled declaratively

## Good showcase ideas for this project

1. Replace the current `subscriptionPromise` / `resolveSubscription()` pattern in `src/App.tsx` with a range stream that naturally suspends through `<Loading>`.
2. Refactor `src/GameOfLife.tsx` into a single async stream abstraction for snapshot + diff + resync.
3. Convert checkbox toggles to `action(...)` plus optimistic helpers, keeping SpacetimeDB as the source of truth.
4. Add a small developer-facing "subscription state" panel that reads native async status (`Loading`, `isPending`, connection state, latest range version) to visibly demonstrate Solid 2.0 behavior.
5. If `Repeat` lands in the final API, evaluate it for the fixed pool rows/cols in place of some generated arrays; this app is a strong demo for count-based rendering.
6. Document the app as a case study: Solid 2.0 is not just rendering the grid, it is expressing staged realtime sync, background revalidation, and optimistic interaction without a separate data layer.

## Concrete implementation plan

### Phase 0: establish showcase targets

- Treat this repo as a Solid 2.0 example app, not just a performant app that happens to use Solid.
- Success criteria:
  - reads are modeled as async computations
  - streaming subscriptions are modeled as async iterables where practical
  - initial readiness uses `<Loading>`
  - background updates use `isPending(...)`
  - writes use `action(...)` and optimistic primitives where they improve clarity

### Phase 1: add a stream adapter layer

- Create a small internal stream toolkit, likely under `src/lib/`:
  - `src/lib/streams.ts`
  - `src/lib/connection-stream.ts`
  - `src/lib/checkbox-stream.ts`
  - `src/lib/gol-stream.ts`
- Goal: move `SubscriptionHandle` and event-listener plumbing out of components.
- Components should consume domain streams and derived state, not raw subscription handles.

Checklist:

- Define a tiny event queue utility for async generators.
- Define a cancellation story via `AbortSignal`.
- Standardize stream event envelopes (`kind`, `data`, `version`, `range`, etc.).
- Make all wrappers own cleanup internally.

### Phase 2: connection state as a stream

- Replace the current boolean-only mental model in `src/main.tsx` with a richer connection model.
- Keep the module-level singleton connection, but expose async state transitions such as:
  - `connecting`
  - `connected`
  - `disconnected`
  - `reconnecting`
  - `resyncing`
- Use that to drive UI affordances and demo visibility.

Checklist:

- Add a connection stream adapter.
- Keep `isConnected` if useful, but derive it from richer state.
- Surface connection phase in the UI, not just a spinner.

### Phase 3: refactor Game of Life first

- `src/GameOfLife.tsx` is the best first migration target because it has a smaller, cleaner snapshot -> diff -> resync flow.
- Replace manual `phase1Handle` / `phase2Handle` / version state with one domain stream.

Checklist:

- Create `golBoardStream()`.
- Yield a bootstrap snapshot event once initial rows are ready.
- Yield diff events for `gol_diff_v2`.
- Emit resync requests when version continuity breaks.
- Let the component consume the stream via async computation + `<Loading>`.
- Keep split effects only for true side effects like `document.title`.

### Phase 4: refactor checkbox viewport subscriptions

- Replace the current `subscriptionPromise`, generation counters, and two-phase range subscription logic in `src/App.tsx` with one range-oriented stream.
- Preserve the current performance model: viewport scoping, bootstrap with full rows, then diff-only live updates.

Checklist:

- Create `checkboxRangeStream(range)`.
- First yield should represent baseline readiness for that visible range.
- Later yields should represent incremental diff events.
- Resubscription should be a stream transition driven by visible range changes.
- Use `<Loading>` for first range load.
- Use `isPending(() => currentRangeState())` for background range swaps.

### Phase 5: move writes to actions and optimistic primitives

- Checkbox toggles are currently a good manual system, but not yet a Solid 2.0 showcase.
- Refactor toward `action(...)` and optimistic state that resets to subscription truth.

Checklist:

- Create `toggleCheckbox = action(...)`.
- Move optimistic overlay state toward `createOptimisticStore(...)` if it fits cleanly.
- Keep round-trip instrumentation, but derive it from the action/stream model where possible.
- Evaluate whether `pendingCountDelta` can become an optimistic derived layer instead of manual bookkeeping.

### Phase 6: add demo-visible async instrumentation

- Make the Solid 2.0 story visible in the product itself.

Checklist:

- Add a small debug/status panel in dev or always-visible lightweight form.
- Show:
  - connection phase
  - current subscription range
  - whether the grid is in initial loading or background pending state
  - latest known server version / generation where relevant
- This makes `Loading`, `isPending`, and stream state concrete for viewers.

### Phase 7: polish toward idiomatic Solid 2.0

- Revisit remaining manual patterns after the stream refactors land.

Checklist:

- Prefer derived computations over write-back state.
- Keep effects split.
- Avoid top-level reactive reads that would warn in stricter Solid 2.0 patterns.
- Evaluate `Repeat` for fixed-count row/column pools if the API stabilizes.

## Suggested delivery order

1. Build generic stream utilities.
2. Refactor Game of Life onto a single stream.
3. Refactor checkbox range sync onto a single stream.
4. Convert checkbox toggles to `action(...)` and optimistic helpers.
5. Add visible async-state instrumentation.
6. Clean up residual imperative state that the new abstractions make obsolete.

## Stream adapter API sketch

### Design goals

- Wrap SpacetimeDB's callback/event APIs in a small async-iterator-friendly layer.
- Keep Solid-specific consumption separate from transport-specific adapters.
- Make cleanup automatic and obvious.
- Support both one-shot readiness and long-lived event feeds.

### Base utility shape

```ts
export interface StreamEnvelope<T> {
  kind: string;
  data: T;
  at?: number;
}

export interface StreamController<T> {
  push(value: T): void;
  error(error: unknown): void;
  close(): void;
}

export function createAsyncQueue<T>(signal?: AbortSignal): {
  push: (value: T) => void;
  error: (error: unknown) => void;
  close: () => void;
  iterable: AsyncIterable<T>;
};
```

- This should be the only low-level queue primitive.
- Everything else should be built from it.

### Generic subscription adapter

```ts
export interface SubscriptionStreamOptions {
  subscribe: () => SubscriptionHandle;
  signal?: AbortSignal;
}

export interface SubscriptionEvent {
  kind: "applied" | "ended" | "error";
  error?: unknown;
}

export function subscriptionEvents(
  options: SubscriptionStreamOptions,
): AsyncIterable<SubscriptionEvent>;
```

- Use this for `onApplied`-style readiness boundaries.
- Components should rarely use this directly; domain adapters should.

### Table event adapter

```ts
export interface TableEvent<Row> {
  kind: "insert" | "update" | "delete";
  row?: Row;
  oldRow?: Row;
}

export function tableEvents<Row>(options: {
  attach: (emit: {
    insert: (row: Row) => void;
    update: (oldRow: Row, row: Row) => void;
    delete: (row: Row) => void;
  }) => () => void;
  signal?: AbortSignal;
}): AsyncIterable<TableEvent<Row>>;
```

- This turns `onInsert` / `onUpdate` / `onDelete` callbacks into one stream.

### Checkbox domain stream

```ts
export interface DocRange {
  min: number;
  max: number;
  wraps: boolean;
}

export type CheckboxRangeEvent =
  | { kind: "snapshot-ready"; range: DocRange; docs: Map<number, Uint8Array> }
  | { kind: "diff"; range: DocRange; documentIdx: number; arrayIdx: number; color: number }
  | { kind: "resync"; range: DocRange; reason: string };

export function checkboxRangeStream(options: {
  conn: DbConnection;
  range: DocRange;
  signal?: AbortSignal;
}): AsyncIterable<CheckboxRangeEvent>;
```

- This is the main target abstraction for `src/App.tsx`.
- Internally it can still do two-phase subscription logic, but the component should only see a domain stream.

### Game of Life domain stream

```ts
export type GolBoardEvent =
  | { kind: "snapshot-ready"; rows: Map<number, Uint8Array>; generation: bigint; version: bigint }
  | { kind: "diff"; version: bigint; data: Uint8Array }
  | { kind: "loop-status"; loopPeriod: number }
  | { kind: "resync"; reason: string };

export function golBoardStream(options: {
  conn: DbConnection;
  signal?: AbortSignal;
}): AsyncIterable<GolBoardEvent>;
```

- This should hide the current phase juggling from `src/GameOfLife.tsx`.

### Connection domain stream

```ts
export type ConnectionPhase =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "resyncing";

export interface ConnectionStateEvent {
  kind: "state";
  phase: ConnectionPhase;
  error?: unknown;
}

export function connectionStateStream(options: {
  conn: DbConnection;
  signal?: AbortSignal;
}): AsyncIterable<ConnectionStateEvent>;
```

## Component consumption sketch

```ts
const rangeState = createMemo(() => checkboxRangeStream({ conn, range: visibleRange() }));
```

- Exact Solid 2.0 consumption mechanics may shift as beta APIs settle, but the architecture target is clear:
  - component derives a stream from reactive inputs
  - Solid handles initial async readiness with `<Loading>`
  - background transitions become observable with `isPending(...)`
  - component renders current projected state, not subscription plumbing

## Immediate next implementation step

- Start with `src/lib/streams.ts` and `src/lib/gol-stream.ts`.
- Game of Life is the smallest end-to-end slice for proving the pattern before applying it to the checkbox grid.

## DOM and JSX changes

- `use:` directives are removed. Replace with `ref` directive factories:

```tsx
<button ref={tooltip({ content: "Save" })} />
<button ref={[autofocus, tooltip({ content: "Save" })]} />
```

- `classList` is removed; use `class` with string/object/array values.
- `attr:` and `bool:` namespaces are removed.
- `oncapture:` is removed.
- Built-in attributes should generally be lowercase and follow HTML semantics.
- Boolean attributes use presence/absence; use string values only when the platform requires literal strings.

## Context and ownership

- Context objects are the provider now:

```tsx
<ThemeContext value="dark">...</ThemeContext>
```

- `Context.Provider` is replaced by the context component form.
- `createRoot` is owned by the parent owner by default; use `runWithOwner(null, ...)` only for intentionally detached long-lived roots.
- `createComputed` is removed. Prefer `createMemo`, split `createEffect`, or derived `createSignal` / `createStore`.

## Practical migration checklist

1. Fix imports first.
2. Replace removed control-flow and boundary APIs (`Index`, `Suspense`, `ErrorBoundary`).
3. Update `createResource` usage to async computations plus `<Loading>`.
4. Remove `batch()` assumptions and any code that expects setters to synchronously change reads.
5. Refactor effects to split compute/apply and move cleanup returns accordingly.
6. Replace `onMount` with `onSettled`.
7. Audit top-level prop reads and reactive destructuring warnings.
8. Convert `classList`, `use:`, `attr:`, `bool:`, and `oncapture:` patterns.
9. Update store helpers (`snapshot`, `merge`, `omit`, draft-first setters).
10. Migrate mutation flows toward `action`, optimistic helpers, and `refresh`.

## Renames / removals at a glance

- `solid-js/web` -> `@solidjs/web`
- `solid-js/store` -> `solid-js`
- `Suspense` -> `Loading`
- `ErrorBoundary` -> `Errored`
- `Index` -> `For keyed={false}`
- `onMount` -> `onSettled`
- `mergeProps` -> `merge`
- `splitProps` -> `omit`
- `unwrap` -> `snapshot`
- `classList` -> `class`
- `createResource` -> async computations + `Loading`
- `startTransition` / `useTransition` -> built-in transitions + `isPending`
- `use:` -> `ref`
- `attr:` / `bool:` -> standard attribute behavior
- `createSelector` -> `createProjection` / derived store patterns
