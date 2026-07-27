# Cymose for Obsidian

A conversation is an ordinary Obsidian **canvas file**. Nodes are messages,
edges are "this reply hangs off that question", and a branch is a second child
of the same node. Read [README.md](README.md) first — the design rests on that
one decision.

## Rules

- **The vault is the storage.** No database, no backend, no state of ours
  outside `.canvas` files and the plugin's own settings. If uninstalling this
  plugin would lose a conversation, the change is wrong.
- **Provider-specific code stops at `src/providers/`.** Auth, request shape and
  stream dialect live behind `ModelAdapter`; nothing above it learns which
  vendor answered.
- **No private Obsidian APIs.** Canvas selection is not exposed publicly, which
  is why the panel has a parent picker instead of reading what's selected.
  Reaching into internals buys a small convenience and breaks on a release.
- **The key goes to the provider and nowhere else.** No telemetry, no
  analytics, no "anonymous" usage ping. Ever.
- **0.1 is BYOK.** Cymose Web sync is a later milestone; don't wire client code
  to it without changing the README, which currently promises the opposite.

## Layout

- `src/canvas.ts` — read/write JSON Canvas, ancestry, layout. No network.
- `src/providers/` — `ModelAdapter` and its implementations.
- `src/view.ts` — the panel: pick a parent, send, stream.
- `src/main.ts` — plugin lifecycle, commands.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | esbuild in watch mode |
| `npm run build` | Typecheck (`tsc --noEmit`) then bundle |

There are no tests yet. `src/canvas.ts` is pure and is where they should start.
