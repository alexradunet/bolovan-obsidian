# Bolovan — domain model

Glossary for the Bolovan plugin. Architecture vocabulary (module, interface,
seam, adapter, depth, locality, leverage) lives in the codebase-design skill;
these are the domain nouns.

- **Run** — one user-triggered agent execution: prompt in, streamed response,
  settle. One run at a time.
- **Session** — a pi session file: the durable record of a conversation.
- **Session lineage** — the chain of sessions Bolovan tracks; the plugin never
  resumes another lineage implicitly.
- **Tracked session** — the session file currently owned by Bolovan's lineage,
  persisted in plugin data.
- **Handshake** — the startup `get_state` exchange proving the pi process is
  alive and reporting its model.
- **Parity** — the plugin agent has the same capabilities as `pi` in a
  terminal in the vault. See ADR-0001.
- **Gate** — the vault's write-approval extension
  (`06-System/Pi/extensions/write-approval.ts`); policy loaded by every pi
  surface.
- **Dialog transport** — Bolovan's rendering of pi extension UI requests as
  Obsidian modals, answered over the RPC dialog protocol.
- **Transcript** — the ordered on-screen record of a conversation, built
  either from session history or from a live run. Items only ever append;
  nothing reorders or disappears.
- **Item** — one block of a transcript: `user`, `assistant` (a markdown text
  block, possibly still streaming), `tool` (a call with running/done/error
  status), or `system` (notices, failures, ran-commands).
