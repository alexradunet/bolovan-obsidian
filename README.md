# Nazar

Nazar runs [pi](https://pi.dev) against your Obsidian vault from inside Obsidian. Each run spawns `pi` in RPC mode with your vault as the working directory, so the agent you get in Obsidian has exactly the same capabilities as `pi` in your terminal: same tools, config, skills, extensions, and models.

Requires the `pi` CLI installed on the machine. Conversations persist in pi's shared session store and stay resumable from the terminal.

## Commands

- **Open Nazar chat** (also the ribbon icon) — sidebar chat over the active pi session: streaming Markdown, tool calls, model and thinking-level switching, session picker, steering while a run is active, Stop. The pi process lives while the view is open.
- **Summarize active note with Nazar** — asks the agent, in the chat, to read and summarize the open note.
- **Stop current agent run** — aborts the running agent.
- **Start a new Nazar conversation** — starts a fresh session.

Settings: an optional explicit `pi` binary path, used when `PATH` lookup is not enough (common when Obsidian's desktop environment differs from your shell).

## Development

Node.js 22.19 or newer. Integration tests spawn a real `pi` process against a synthetic vault, so `pi` must be installed to run the suite.

```bash
npm install
npm test
npm run build
```

Engineering rules live in [AGENTS.md](AGENTS.md); load-bearing decisions in [docs/adr/](docs/adr/).
