/**
 * Entry point — sets up the SpacetimeDB WebSocket connection and wraps the
 * app in the provider so any component can subscribe to tables or call reducers.
 *
 * The connection is configured once at the module level (not inside a component)
 * to avoid reconnecting on every re-render.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { Identity } from 'spacetimedb';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection, ErrorContext } from './module_bindings/index.ts';

// Read connection config from environment variables (set in .env.local or Vercel)
const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? 'react-ts';

// Auth tokens are cached per host+db so returning users keep their identity
const TOKEN_KEY = `${HOST}/${DB_NAME}/auth_token`;

const onConnect = (_conn: DbConnection, identity: Identity, token: string) => {
  // Persist the token so the same identity is used on next page load
  localStorage.setItem(TOKEN_KEY, token);
  console.log(
    'Connected to SpacetimeDB with identity:',
    identity.toHexString()
  );
};

const onDisconnect = () => {
  console.log('Disconnected from SpacetimeDB');
};

const onConnectError = (_ctx: ErrorContext, err: Error) => {
  console.log('Error connecting to SpacetimeDB:', err);
};

// Build the connection once — SpacetimeDBProvider manages the lifecycle
const connectionBuilder = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(localStorage.getItem(TOKEN_KEY) || undefined)
  .onConnect(onConnect)
  .onDisconnect(onDisconnect)
  .onConnectError(onConnectError);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>
);
