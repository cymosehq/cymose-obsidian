# Cymose for Obsidian

Branch an AI conversation across a real Obsidian canvas instead of one linear
chat. — [cymose.dev/obsidian](https://cymose.dev/obsidian)

Ask the same question three ways, keep the answer that held up, and still be
able to find the two that didn't — and why. Every other AI plugin for Obsidian
gives you a chat box in the sidebar; the conversations worth having aren't a
single line.

## 0.1 beta — read this first

- **This is a 0.1 beta.** The loop below works end to end. Most of the concept
  does not exist yet — see [What's not here](#whats-not-here).
- **Bring your own key.** It runs on your own [OpenRouter](https://openrouter.ai)
  key: one key, every model (Claude, GPT, Gemini, DeepSeek, Qwen, Kimi, GLM…).
  There is no Cymose account, no server of ours in the path of a message, and
  no telemetry. You pay OpenRouter directly at their rates.
- **Integration with [Cymose Web](https://cymose.dev) comes later.** Syncing a
  canvas here with the web product is a later milestone. Nothing in this build
  talks to it.

## This code was written by an AI

Every line in this repository was written by an AI coding agent (Claude, via
Claude Code) working from my direction. I decide what gets built, review it at
the level of behaviour, and test it. I do not hand-write the code — I am not a
programmer.

Stated up front because you're about to give a plugin your API key and let it
write files in your vault:

- **Read it before you trust it.** There is no experienced human author who
  checked every line. It is a small codebase and deliberately readable.
- **What it writes:** `.canvas` files in your conversations folder, and its own
  settings. Nothing else in your vault is touched.
- **What it sends:** your messages and the branch above them, to OpenRouter,
  on your key. Nowhere else.
- **Bugs are my responsibility, not the model's.** Report them and they get
  fixed.

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

1. Settings → Cymose → paste your OpenRouter key.
2. Command palette → **Cymose: New conversation** (or **Start a conversation
   about this note**, which embeds the note in the first node so the canvas
   stays linked in your graph).
3. Type in the panel, press Enter. Your message becomes a node; the answer
   streams into the panel and lands as a node under it.
4. To branch: change **Branch from** to any earlier node and ask something
   else. The new line inherits that node's history, not its siblings'.

## What's not here

The concept this is built from includes a lot more. Honest state of it:

| | |
|---|---|
| Canvas conversations, branching, context inheritance | **works** |
| Streaming answers | **works** |
| Any OpenRouter model, per-vault settings | **works** |
| Start a conversation from a note | **works** |
| Explore 3 ways (one click → three strategies) | not yet |
| Promote a conclusion back to the parent | not yet |
| Compare & combine two branches | not yet |
| Ask-the-whole-tree | not yet |
| Scheduled nodes (Flows), web search, attachments, voice | not yet |
| Summarised (rather than full) ancestor context | not yet |
| Providers other than OpenRouter | not yet — the adapter interface is there |

Long branches send their full history today. That is fine for a dozen turns and
wasteful after that; compressing ancestors into a summary is the next thing.

## Install

Not in the community plugin directory yet. Build it and drop it in:

```sh
npm install
npm run build
mkdir -p /path/to/vault/.obsidian/plugins/cymose
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/cymose/
```

Then enable it in Settings → Community plugins. Or point
[BRAT](https://github.com/TfTHacker/obsidian42-brat) at this repository.

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
