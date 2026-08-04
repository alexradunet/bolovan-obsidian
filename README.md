# Bolovan

Bolovan runs [pi](https://pi.dev) against your Obsidian vault from inside Obsidian. Each run spawns `pi` in RPC mode with your vault as the working directory, so the agent you get in Obsidian has exactly the same capabilities as `pi` in your terminal: same tools, config, skills, extensions, and models.

Requires the `pi` CLI installed on the machine. Conversations persist in pi's shared session store and stay resumable from the terminal.

## Commands

- **Open Bolovan chat** (also the ribbon icon) — adaptive sidebar chat over the active pi session: streaming Markdown, tool calls, model and thinking-level switching, session picker, steering while a run is active, and Stop.
- **Open Bolovan chat in new tab** — moves the same conversation into a spacious editor tab. Bolovan keeps one chat surface and one active conversation rather than duplicating the session across leaves.
- **Summarize active note with Bolovan** — asks the agent, in the chat, to read and summarize the open note.
- **Stop current agent run** — aborts the running agent.
- **Start a new Bolovan conversation** — starts a fresh session.

## Chat context

Messages carry note context with them, Copilot-style:

- **Active note** — the open note is attached automatically. The file icon in the composer toggles this; the context line above the input shows what will travel with the next message.
- **Wikilink mentions** — type `[[` in the composer to pick more notes from a ranked list, just like linking in a note. Mentions render as Obsidian-style links; clicking one expands it into editable `[[note]]` text, and it collapses again when the caret leaves. The paperclip button opens the same list as a fuzzy search.

Attached notes appear as links on sent messages, and wikilinks in the agent's replies are clickable too — each one opens the note in Obsidian.

Attached notes are inlined into the prompt pi receives, so the agent has their contents without spending a tool call. The transcript shows attachment chips on messages instead of the raw contents.

The pi process lives while the chat view is open. Extension dialogs — including the vault's write-approval gate — appear as Obsidian modals.

Settings: an optional explicit `pi` binary path, used when `PATH` lookup is not enough (common when Obsidian's desktop environment differs from your shell).

## Development

Node.js 22.19 or newer. Integration tests spawn a real `pi` process against a synthetic vault, so `pi` must be installed to run the suite.

```bash
npm install
npm test
npm run build
```

Engineering rules live in [AGENTS.md](AGENTS.md); load-bearing decisions in [docs/adr/](docs/adr/).
