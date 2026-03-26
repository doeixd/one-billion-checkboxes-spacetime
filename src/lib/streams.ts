import type { SubscriptionHandle } from "../module_bindings/index.ts";

type QueueResult<T> = IteratorResult<T>;

export interface AsyncQueue<T> {
  push(value: T): void;
  error(reason: unknown): void;
  close(): void;
  iterable: AsyncIterable<T>;
}

export function createAsyncQueue<T>(signal?: AbortSignal): AsyncQueue<T> {
  const values: T[] = [];
  const settles: Array<{
    resolve: (value: QueueResult<T>) => void;
    reject: (reason: unknown) => void;
  }> = [];

  let closed = false;
  let failure: unknown;

  const flushClose = () => {
    while (settles.length > 0) {
      settles.shift()!.resolve({ value: undefined, done: true });
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    flushClose();
  };

  const push = (value: T) => {
    if (closed || failure !== undefined) return;
    const settle = settles.shift();
    if (settle) {
      settle.resolve({ value, done: false });
      return;
    }
    values.push(value);
  };

  const error = (reason: unknown) => {
    if (closed || failure !== undefined) return;
    failure = reason;
    while (settles.length > 0) {
      settles.shift()!.reject(reason);
    }
  };

  signal?.addEventListener("abort", close, { once: true });

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failure !== undefined) {
            return Promise.reject(failure);
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<QueueResult<T>>((resolve, reject) => {
            settles.push({ resolve, reject });
          });
        },
        return() {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(reason: unknown) {
          error(reason);
          return Promise.reject(reason);
        },
      };
    },
  };

  return { push, error, close, iterable };
}

export type TableEvent<Row> =
  | { kind: "insert"; row: Row }
  | { kind: "update"; oldRow: Row; row: Row }
  | { kind: "delete"; row: Row };

export function tableEvents<Row>(options: {
  signal?: AbortSignal;
  attach: (handlers: {
    insert: (row: Row) => void;
    update: (oldRow: Row, row: Row) => void;
    delete: (row: Row) => void;
  }) => () => void;
}): AsyncIterable<TableEvent<Row>> {
  const queue = createAsyncQueue<TableEvent<Row>>(options.signal);
  const detach = options.attach({
    insert: row => queue.push({ kind: "insert", row }),
    update: (oldRow, row) => queue.push({ kind: "update", oldRow, row }),
    delete: row => queue.push({ kind: "delete", row }),
  });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    detach();
    queue.close();
  };

  options.signal?.addEventListener("abort", close, { once: true });

  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* queue.iterable;
      } finally {
        close();
      }
    },
  };
}

export type SubscriptionEvent =
  | { kind: "applied" }
  | { kind: "error"; error: unknown }
  | { kind: "end" };

export function subscriptionEvents(options: {
  signal?: AbortSignal;
  start: (handlers: {
    applied: () => void;
    error: (error: unknown) => void;
  }) => SubscriptionHandle;
}): AsyncIterable<SubscriptionEvent> {
  const queue = createAsyncQueue<SubscriptionEvent>(options.signal);
  let closed = false;
  const handle = options.start({
    applied: () => queue.push({ kind: "applied" }),
    error: error => {
      queue.push({ kind: "error", error });
      queue.error(error);
    },
  });

  const close = () => {
    if (closed) return;
    closed = true;
    if (!handle.isEnded()) {
      try {
        handle.unsubscribe();
      } catch {}
    }
    queue.push({ kind: "end" });
    queue.close();
  };

  options.signal?.addEventListener("abort", close, { once: true });

  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* queue.iterable;
      } finally {
        close();
      }
    },
  };
}
