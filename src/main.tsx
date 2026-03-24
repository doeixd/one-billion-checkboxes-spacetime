/**
 * Entry point — builds the SpacetimeDB WebSocket connection once at module
 * level (never inside a component so it never reconnects on re-render), then
 * mounts the SolidJS app.
 *
 * `isConnected` is a module-level SolidJS signal so any component can read it
 * reactively without needing a context provider.
 */
import { createSignal, Show } from 'solid-js';
import { render } from '@solidjs/web';
import { inject } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import FingerprintJS from '@fingerprintjs/fingerprintjs';
import App from './App.tsx';
import GameOfLife from './GameOfLife.tsx';
import { DbConnection } from './module_bindings/index.ts';
import type { ErrorContext } from './module_bindings/index.ts';
import { Identity } from 'spacetimedb';

inject();
injectSpeedInsights();

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'deni-x4u44';
const TOKEN_KEY = `${HOST}/${DB_NAME}/auth_token`;

// Module-level reactive signal — updated by connection callbacks, read by App
export const [isConnected, setIsConnected] = createSignal(false);

// Simple path-based routing (no router dependency needed)
export const [currentPath, setCurrentPath] = createSignal(window.location.pathname);
window.addEventListener('popstate', () => setCurrentPath(window.location.pathname));


const onConnect = (conn: DbConnection, _identity: Identity, token: string) => {
  localStorage.setItem(TOKEN_KEY, token);
  setIsConnected(true);

  // Register browser fingerprint for rate limiting (fire-and-forget)
  FingerprintJS.load().then(fp => fp.get()).then(result => {
    conn.reducers.registerFingerprint({ fingerprint: result.visitorId });
  });
};

const onDisconnect = () => {
  setIsConnected(false);
};

const onConnectError = (_ctx: ErrorContext, err: Error) => {
  console.error('SpacetimeDB connection error:', err);
};

export const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withConfirmedReads(false)
  .withToken(localStorage.getItem(TOKEN_KEY) || undefined)
  .onConnect(onConnect)
  .onDisconnect(onDisconnect)
  .onConnectError(onConnectError)
  .build();

render(() => (
  <Show when={currentPath() === '/life'} fallback={<App />}>
    <GameOfLife />
  </Show>
), document.getElementById('root')!);
