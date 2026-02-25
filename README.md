# One Million Checkboxes

A real-time collaborative app with one million checkboxes, built with [SpacetimeDB](https://spacetimedb.com/?referral=gillkyle) and React.

Inspired by the original [One Million Checkboxes](https://onemillioncheckboxes.com/) by Nolen Royalty.

## How it works

- **1,000,000 checkboxes** are stored as bit-packed arrays across 250 database rows (4,000 checkboxes per row, 500 bytes each)
- **Real-time sync** — all connected clients see changes instantly via SpacetimeDB subscriptions
- **Virtual scrolling** — only visible checkboxes are rendered using [react-window](https://github.com/bvaughn/react-window)
- **"Poison the well"** — a scheduled reducer randomly toggles checkboxes every 10 seconds

## Stack

- **Backend**: [SpacetimeDB](https://spacetimedb.com/?referral=gillkyle) (TypeScript module)
- **Frontend**: React + Vite
- **Hosting**: [Vercel](https://vercel.com)

## Development

```bash
npm install
npm run dev
```

### Publishing the SpacetimeDB module

```bash
spacetime publish <db-name> -p ./spacetimedb --delete-data=always -y
spacetime generate --lang typescript --out-dir src/module_bindings -p ./spacetimedb
```

## License

ISC
