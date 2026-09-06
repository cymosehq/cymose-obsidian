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
- **Cymose is not a chat provider.** Turns go to the provider in settings on
  the user's key. Do not add a Cymose chat adapter without changing the README,
  which currently promises the opposite.

## Layout

- `src/canvas.ts` — read/write JSON Canvas, ancestry, layout. No network.
- `src/canvas-api.ts` — the guarded bridge to the live canvas view: what is
  selected, and revealing a node. The only file allowed to know Obsidian's
  internals.
- `src/providers/` — `ModelAdapter`. `create.ts` picks OpenRouter, OpenAI,
  Anthropic, Google, or a custom OpenAI-compatible base URL.
- `src/view.ts` — composer docked on the canvas view. Not a sidebar ItemView.
  The board is the conversation; this file is send / stream / explore / promote.
- `src/main.ts` — plugin lifecycle, commands.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | esbuild in watch mode |
| `npm run build` | Typecheck (`tsc --noEmit`) then bundle |
| `npm test` | Run the vitest suites (`src/*.test.ts`), watch mode |

`src/canvas.ts`, `src/markers.ts` and `src/models.ts` are pure and have vitest
coverage. CI runs `npm test -- --run` before the build. `src/view.ts` and the
providers touch the DOM/network; those tests come next.
