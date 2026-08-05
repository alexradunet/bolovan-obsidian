# Bolovan — domain model

- **Run** — one user-triggered harness execution. One run may contain several model/tool rounds; only one run is active at a time.
- **Harness** — the orchestration boundary that owns model calls, tool rounds, approval, cancellation, and persistence.
- **Model endpoint** — a device-local OpenAI-compatible configuration: base URL, API key, and model name.
- **Model adapter** — the normalized completion interface hiding provider request and response details.
- **Model-facing tool interface** — the stable set of bounded capabilities advertised to the model. Each capability keeps its definition and invocation together; the Harness owns Run policy around the result.
- **Vault tool** — one of `vault_read`, `vault_search`, `vault_list`, or `vault_change`; all operate through Obsidian APIs. Reads under `.obsidian` go through `vault.adapter`; writes there stay refused.
- **Web reader** — the read-only `web_read` tool fetches a user-supplied HTTP or HTTPS URL through Obsidian's network API and returns bounded readable text. Page content is untrusted data, not agent instructions.
- **Prepared change** — an immutable exact preview plus a commit closure bound to the source hash.
- **Brain** — the visible configurable vault folder identified by `bolovan-brain.json`.
- **Conversation** — a logical sequence of user, assistant, and tool messages.
- **Branch** — one device-owned conversation file. Writing a foreign branch first creates a local fork, so sync conflicts are preserved rather than guessed together.
- **Transcript** — the ordered on-screen rendering of a conversation. Items append and never reorder.
- **Attachment** — a note whose contents are inlined into one outgoing user message.
- **Mention** — a `[[note]]` link in the composer that resolves to an attachment at send time.
- **Read-only self-inspection** — the agent may read and list its own plugin source under `.obsidian/plugins/bolovan`, but never modify anything under `.obsidian`.

- **Skill** — portable procedural memory stored as Markdown under the brain's `Skills` folder. Bolovan may propose creating or refining a skill from observed reusable experience, but the exact write requires approval and grants no new tool authority.