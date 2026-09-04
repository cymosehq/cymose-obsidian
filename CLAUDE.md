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
- **Private Obsidian APIs only through `src/canvas-api.ts`, guarded.** Canvas
  selection is not exposed publicly. This rule used to say "never", and the
  price was the product's central gesture: you pointed at a node on the canvas
  and the panel made you find it again in a list. So we reach in, under three
  conditions — every access feature-detected and wrapped so nothing throws, a
  fallback path that still works when the bridge reports nothing, and reads
  only (canvas *data* is still written through the `.canvas` file). One file
  knows the shape of someone else's internals; a bad Obsidian release costs a
  convenience, not the plugin. Anywhere else, the answer is still no.
- **The key goes to the provider and nowhere else.** No telemetry, no
  analytics, no "anonymous" usage ping. Ever.
- **0.1 is BYOK.** Cymose Web sync is a later milestone; don't wire client code
  to it without changing the README, which currently promises the opposite.

## Layout

- `src/canvas.ts` — read/write JSON Canvas, ancestry, layout. No network.
- `src/canvas-api.ts` — the guarded bridge to the live canvas view: what is
  selected, and revealing a node. The only file allowed to know Obsidian's
  internals.
- `src/providers/` — `ModelAdapter` and its implementations.
- `src/view.ts` — the panel: what you are branching from, send, stream.
- `src/main.ts` — plugin lifecycle, commands.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | esbuild in watch mode |
| `npm run build` | Typecheck (`tsc --noEmit`) then bundle |
| `npm test` | Run the vitest suites (`src/*.test.ts`), watch mode |

`src/canvas.ts`, `src/markers.ts` and `src/models.ts` are pure and have real
vitest coverage (`canvas.test.ts`, `markers.test.ts`, `models.test.ts`) — CI
runs `npm test -- --run` before the build. `src/view.ts` and the providers
touch the DOM/network and would need mocking to be worth it.

Keep network parsing separate from the network call, the way `readCatalogue`
is split out of `fetchCatalogue`: the judgement about what a server sent is
the part worth testing, and it should not need a socket to run.
