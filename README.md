# One Billion Checkboxes

A real-time collaborative app with **one billion checkboxes**, built with [SpacetimeDB](https://spacetimedb.com/?referral=gillkyle) and [Solid 2.0 (beta)](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/README.md).

**Live at [one-billion-checkboxes-spacetime.vercel.app](https://one-billion-checkboxes-spacetime.vercel.app/)**

Inspired by the original [One Million Checkboxes](https://onemillioncheckboxes.com/) by Nolen Royalty.

## How it works

- **1,000,000,000 checkboxes** stored as nibble-packed arrays across 250,000 database rows (4,000 checkboxes per row, 2,000 bytes each) — 15 colors per cell
- **Real-time sync** — all connected clients see changes instantly via SpacetimeDB subscriptions
- **Virtual scrolling** — only visible checkboxes are rendered using a fixed DOM pool with fine-grained Solid reactivity
- **Viewport-scoped subscriptions** — only data for visible checkboxes is fetched, with debounced resubscription on scroll
- **"Poison the well"** — a scheduled reducer randomly toggles checkboxes every 10 seconds

## Stack

- **Backend**: [SpacetimeDB](https://spacetimedb.com/?referral=gillkyle) (TypeScript module)
- **Frontend**: [Solid 2.0 beta](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/README.md) + Vite
- **Hosting**: [Vercel](https://vercel.com)

## Development

```bash
npm install
npm run dev
```

### Publishing the SpacetimeDB module

```bash
spacetime publish <db-name> -p ./spacetimedb
spacetime generate --lang typescript --out-dir src/module_bindings -p ./spacetimedb
```

## License

ISC
