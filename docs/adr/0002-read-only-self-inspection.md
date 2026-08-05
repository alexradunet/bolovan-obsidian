# ADR 0002: Read-only self-inspection through Vault.adapter

Date: 2026-08-04
Status: Accepted

## Context

The agent could not read its own source code, ADRs, or tests: `safePath` refused every path under `.obsidian`, and Obsidian's `Vault` API never indexes that folder anyway. Learning about its own behavior required copying files into the vault by hand. The write seal is what protects settings, approval state, and plugin code — reading changes none of that.

## Decision

`vault_read` and `vault_list` may reach only Bolovan's own directory under `<Vault.configDir>/plugins/bolovan` through `Vault.adapter` (`exists`, `read`, `list`). Obsidian's `Vault` API does not index the configuration directory, so reads there bypass it by design. Other plugins, Obsidian settings, and unrelated hidden files remain outside the capability.

The write seal moves from `safePath` into `vault_change`: every path equal to `Vault.configDir` or under it is refused before a preview is prepared, with the original refusal message. `safePath` keeps its traversal checks for every tool.

The system prompt states both halves of the boundary: the agent may read and list the plugin's own source under `.obsidian/plugins/bolovan`, and it can never modify `.obsidian`.

## Consequences

- The agent can read and list its own source, tests, and ADRs directly during a quest without gaining access to unrelated hidden configuration.
- `vault_search` stays Markdown-only by design; finding text inside plugin sources still needs `vault_read` on a path the agent already knows or listed.
- `Vault.adapter` is public API on desktop and mobile, so the exception costs no platform support.
- Self-modification, settings writes, and approval-state writes remain sealed exactly as before; only the direction of access changed.
