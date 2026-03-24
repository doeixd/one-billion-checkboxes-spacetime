/**
 * Entry point — builds the SpacetimeDB WebSocket connection once at module
 * level (never inside a component so it never reconnects on re-render), then
 * mounts the SolidJS app.
 *
 * `isConnected` is a module-level SolidJS signal so any component can read it
 * reactively without needing a context provider.
 */
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import App from './App.tsx';
import { DbConnection } from './module_bindings/index.ts';
import type { ErrorContext } from './module_bindings/index.ts';
import { Identity } from 'spacetimedb';

const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'react-ts';
const TOKEN_KEY = `${HOST}/${DB_NAME}/auth_token`;

// Module-level reactive signal — updated by connection callbacks, read by App
export const [isConnected, setIsConnected] = createSignal(false);

const onConnect = (_conn: DbConnection, identity: Identity, token: string) => {
  localStorage.setItem(TOKEN_KEY, token);
  console.log('Connected to SpacetimeDB:', identity.toHexString());
  setIsConnected(true);
};

const onDisconnect = () => {
  console.log('Disconnected from SpacetimeDB');
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

render(() => <App />, document.getElementById('root')!);
