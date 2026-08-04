# ADR 0001: Integrate pi over RPC with literal capability parity

Date: 2026-08-04
Status: Accepted

## Context

Bolovan's first spike embedded the pi SDK (`@earendil-works/pi-coding-agent`, `pi-ai`, `typebox`) directly in the Obsidian plugin bundle and registered a private local-llamafile provider with one scoped `vault_read` tool.

That approach hit three walls:

1. **Size.** The SDK inlines ~7.5 MB of agent runtime into `main.js`, loaded inside Obsidian's renderer, plus ~370 MB of `node_modules` at development time.
2. **Coupling.** The plugin pinned SDK 0.83.0 while the system pi CLI was 0.82.1; the two surfaces drift independently on every update.
3. **Capability.** The goal became literal parity: opening `pi` in the vault from a terminal or from inside Obsidian should present the same agent — same tools, config, skills, extensions, and model layer. With the SDK, parity would have to be maintained by hand (the spike deliberately disabled extensions, skills, and context files).

## Decision

Bolovan spawns `pi --mode rpc` as a child process per run and speaks the JSONL RPC protocol over stdin/stdout. The plugin ships no pi code.

Parity is literal:

- Spawn cwd is the vault root with `--approve`, so project resources load exactly as they would for the TUI.
- No lockdown flags, no system-prompt override, no tool restriction, no isolated config dir in production.
- Sessions persist in pi's shared store; Bolovan tracks its own session file (`--session <path>`) so plugin lineage never mixes with other sessions implicitly, and plugin conversations remain resumable from the TUI.
- The pi binary is resolved on `PATH` with an optional explicit-path setting; startup handshake is `get_state`, and failures are reported visibly with the binary tried and pi's stderr tail.

## Retired constraints

The previous architecture mandated, now formally retired:

- "Inference is local and offline through a managed llamafile process." Model choice is pi's; local models remain available through pi's normal model configuration.
- "Llamafiles come only from the bundled catalog." No bundled catalog; no managed inference runtime.
- "Agents have no network, shell, or raw-filesystem tools." The plugin agent has pi's full built-in toolset, identical to the TUI.
- "Vault access goes through Obsidian's Vault and MetadataCache interfaces" and the associated scoping model (`General`/`Journal`). Vault access is pi's file tools rooted at the vault cwd.
- "Every write requires a visible diff and explicit approval." The plugin renders every tool execution visibly and offers cancel; a gate, if ever needed, will be a pi extension loaded by TUI and plugin alike.
- "No automatic cloud or model fallback." Provider behavior is pi's configuration concern.

Kept: runs are user-triggered; failures stop visibly; tool executions render visibly; verification with synthetic vaults only.

## Consequences

- The plugin bundle shrinks from ~7.5 MB to ~7 KB; pi's dependencies leave the repo entirely.
- Bolovan requires the pi CLI installed on the machine. Protocol drift between pi versions is accepted; the startup handshake is the compatibility check and failures stay visible.
- Tests spawn a real `pi` process against an isolated pi config dir (`PI_CODING_AGENT_DIR`) and a synthetic model server, while production runs fully parity. The asymmetry is deliberate: hermetic tests, parity production.
- Safety comes from the same place it comes from in the TUI: an explicit user trigger, visible streaming, cancel, and the session record.

## Alternatives considered

- **Keep the SDK, lazy-load it from disk.** Fixes bundle size but keeps renderer coupling, version skew, and hand-maintained parity. Rejected.
- **RPC with a restricted tool tier (scoped default, opt-in full parity).** Maintains two agents for a user base of one developer; a weaker tier can be retrofitted cheaply if a real need appears. Rejected.
- **SDK-style vault tools over a reverse channel (loopback HTTP/IPC).** Only needed for scoped Obsidian-API access, which parity retired. Rejected.
