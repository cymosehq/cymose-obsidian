# Cymose for Obsidian

Branch an AI conversation across a real Obsidian canvas instead of one linear
chat. — [cymose.dev/obsidian](https://cymose.dev/obsidian)

Ask the same question three ways, keep the answer that held up, and still be
able to find the two that didn't — and why. Every other AI plugin for Obsidian
gives you a chat box in the sidebar; the conversations worth having aren't a
single line.

## Getting started

- **Sign in and it works.** A Cymose account on the free tier gets the same
  allowance as the web app; a plan raises it. One account, one bill, the same
  credits whether you're on a canvas in a browser or a canvas in your vault.
- **Bringing your own key is the second path, not the first.** Paste an
  [OpenRouter](https://openrouter.ai) key instead and turns go straight to
  OpenRouter on your account, spending your provider credit rather than Cymose
  credits. Both work; the key wins if both are set, so nobody who set one up
  before this existed is signed out or asked anything.
- **Cymose Web sync reads only.** The same account also lets you pull a tree
  you planned in the browser onto a canvas here (see [Pull a tree from the
  web](#pull-a-tree-from-the-web)). One-directional: nothing in your vault is
  uploaded. Writing back is a later milestone.

## What this plugin can do to you

The short version, because you are about to give a plugin a credential and let
it write files in your vault. Every line of it is checkable against the source,
which is eight files and under 2000 lines, comments included.

- **What it writes:** `.canvas` files in your conversations folder, and its own
  settings. It never modifies a note. Pinning a note reads it; the embed goes
  into the canvas, not into the note.
- **Where a turn goes:** to Cymose if you signed in, or to OpenRouter if you
  set a key. One of the two, never both, and nowhere else. No analytics, no
  telemetry, no third host.
- **What is kept:** not the conversation. Turns are sent with `ephemeral` set,
  which means the API answers them and stores no workspace and no messages —
  what it records is that a turn happened, because that is what bills your
  credits. On an OpenRouter key we are not in the path at all and OpenRouter's
  retention policy is the one that applies.
- **What survives us:** everything. A conversation is a JSON Canvas file in
  your vault, in Obsidian's own format. Uninstall the plugin and the
  conversations are still there and still readable.

### Written by an AI

Every line in this repository was written by an AI coding agent (Claude, via
Claude Code) working from my direction. I decide what gets built, review it at
the level of behaviour, and test it. I do not hand-write the code.

Say what you like about that; the guarantees above are the same either way,
because they are properties of what the code does and not of who typed it. The
one honest objection is whether someone who did not write the code can fix it.
The answer is response time: [open an
issue](https://github.com/cymosehq/cymose-obsidian/issues) and see. Bugs are my
responsibility, not the model's.

## How it works

A conversation is an ordinary Obsidian **canvas file**. Each message is a node;
each reply hangs under its question; a branch is a second child of the same
node.

```
        ┌─ "explain the tradeoff" ─┐
        │                           │
   "rate limiting?"            "show me code"
        │                           │
   token bucket              sliding window
```

That one decision buys most of the product:

- **Branching is free.** Fork from any node — the canvas is already a graph.
- **Context inherits down the branch.** A turn is sent with the chain from that
  node up to the root, so a fork carries everything above it and nothing beside
  it. Sibling branches stay invisible to each other, which is the point.
- **It's your file.** Pan, zoom, rearrange, link notes into it, edit a node by
  hand, keep it in git. If this plugin disappears tomorrow the conversation is
  still a readable file in your vault, in Obsidian's own format.

## Use it

1. Settings → Cymose → paste your Cymose token. (Or an OpenRouter key, if you
   would rather spend that.)
2. Command palette → **Cymose: New conversation** (or **Start a conversation
   about this note**, which embeds the note in the first node so the canvas
   stays linked in your graph).
3. Type in the panel, press Enter. Your message becomes a node; the answer
   streams into the panel and lands as a node under it.
4. To branch: change **Branch from** to any earlier node and ask something
   else. The new line inherits that node's history, not its siblings'.

### Explore 3 ways

Type a question and press **Explore 3 ways** instead of Send. It asks three
times with three different instructions — the straight answer, one that
questions an assumption in the question, and one that goes for the option with
the higher ceiling — and hangs all three under your question as siblings.

Not three samples at a high temperature. That gives three paraphrases of one
idea, which is worth nothing to compare. Three different instructions give three
genuinely different answers, side by side, none contaminated by the other two.

### Promote a conclusion

This is the half of branching that nobody else does. Forking is easy and every
canvas has it; the problem is the way back up. A decision made three levels down
stays down there, and the next branch you open re-litigates it.

Select the end of a branch in **Branch from** and press **Promote**. The branch
is compressed into what it settled — what was decided, what was ruled out, why —
and that lands in the node the branch forked from, as a callout you can edit or
delete by hand. Every branch you open there afterwards inherits it, because the
context a turn is sent is already the chain up to the root.

Promoting the same branch again updates its conclusion in place. A different
branch promoting into the same node is a second conclusion and gets its own
block.

### Pin a note to a node

Press **Pin a note** and pick one. It goes into the node as an ordinary
`![[embed]]`, so the canvas shows it inline and your graph view knows about the
link — and every branch below that node is answered with the note's contents in
context.

Resolved when the turn is sent, not when you pin it: edit the note and every
branch below it is answered against the new text, without re-pinning anything.
Notes are read, never written.

### Pull a tree from the web

Optional, and only if you also use Cymose on the web.

1. Settings → Cymose → **Cymose access token**, from your account on the web.
2. Command palette → **Cymose: Pull a tree from Cymose Web**, then pick a tree.

It writes a new canvas with the structure of that tree: each node's title, the
conclusions promoted up from its branches, and the names of any notes pinned to
it. Not the transcripts — a canvas of full conversations is unreadable at the
zoom level where a tree is useful, and the export doesn't carry them anyway.

Pulling the same tree again updates the nodes where they stand instead of
adding a second copy, and anything you dragged keeps its position. Nodes
deleted on the web are left alone: this is a mirror, not a replica, and
deleting something out of your vault because a server stopped mentioning it is
not a trade worth making.

## What a branch costs

Worth knowing before you run up a bill: a turn is sent with the whole chain
above it, so the fortieth turn on one line costs a great deal more than the
first. Promote is the lever. Once a branch is promoted, a *new* branch opened at
the fork point inherits five lines of conclusion instead of forty turns of
transcript — cheaper per turn, and usually the better conversation, because the
model is reading what you decided rather than everything you said on the way.

Anything missing or broken, [open an
issue](https://github.com/cymosehq/cymose-obsidian/issues).

## Install

**From Obsidian** — Settings → Community plugins → Browse → search **Cymose**.
Not listed yet; the submission goes in with this release, and review takes
weeks, so the two routes below are the ones that work today.

**Until then, [BRAT](https://github.com/TfTHacker/obsidian42-brat)** is the
one-step path: install BRAT, run *Add beta plugin*, paste
`cymosehq/cymose-obsidian`. It installs from the latest release and keeps
itself updated.

**Or by hand**, from a release:

```sh
# Download main.js, manifest.json and styles.css from
# https://github.com/cymosehq/cymose-obsidian/releases/latest
mkdir -p /path/to/vault/.obsidian/plugins/cymose
mv main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/cymose/
```

Then enable it in Settings → Community plugins, and paste your Cymose token in
Settings → Cymose.

## Releasing

Tag-driven. Obsidian's convention is a bare version with no leading `v`, and
the tag must match `manifest.json` — the directory installs by version, so a
mismatch is a release that looks fine until someone tries to install it.

```sh
# bump manifest.json and package.json to the same version, commit, then:
git tag 0.1.1 && git push origin 0.1.1
```

The workflow builds, checks the tag against the manifest, and attaches
`main.js`, `manifest.json` and `styles.css` to the release as individual files
— BRAT and the community directory fetch them by name, and a zip of the same
three installs as nothing.

### Getting into the community directory

1. The repository needs `manifest.json`, `README.md` and `LICENSE` at its root
   (they are) and must be public.
2. Cut a release whose tag equals `manifest.json`'s version, with those three
   files attached — the workflow above does exactly this.
3. Sign in at [community.obsidian.md](https://community.obsidian.md), link the
   GitHub account, then **Plugins → New plugin** and give it this repository's
   URL. (The old route was a pull request against `obsidian-releases`; it is a
   form now.)
4. A bot checks the manifest and the release; a human reviews after it passes.
   Expect changes to be requested — the usual ones are the global `app` object,
   `innerHTML`, listeners that aren't cleaned up on unload, and hardcoded
   styles. This plugin uses `this.app`, builds DOM with `createEl`, registers
   every listener through Obsidian, and styles from CSS classes — but the
   review is real and takes weeks, not days.

## Contributing

A new provider is one file implementing `ModelAdapter` in `src/providers/`,
plus a line in settings. That is the extension point most worth having, and the
one the interface exists for.

Use whatever tools you like, and say so — AI-assisted contributions are welcome
on the same terms as any other: you read it, you're responsible for it, you can
explain why it's correct.

## Licence

[Apache-2.0](LICENSE). "Cymose" is a project name, not part of the grant —
forks are welcome, please rename.
