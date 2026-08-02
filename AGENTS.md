# Nazar engineering guide

Write code for human working memory. A reader should not need to hold more than a few facts at once to understand a change.

Sources:

- [Cognitive load guidance for agents](https://github.com/zakirullin/cognitive-load/blob/main/README.agents.md)
- [Cognitive Load Is What Matters](https://github.com/zakirullin/cognitive-load)

## Prime directive

Reduce extraneous cognitive load. Prefer boring, direct code whose behavior is visible locally. Optimize for the person debugging this six months from now.

## Coding rules

- Name intermediate values so complex conditions read as a short list of facts.
- Prefer early returns over nested conditionals.
- Prefer composition over inheritance.
- Keep related behavior together. Do not split code to satisfy arbitrary file, class, or function-size rules.
- Prefer a few deep modules with small interfaces over many shallow modules.
- Use the smallest familiar subset of TypeScript that expresses the behavior clearly.
- Use self-describing strings and domain terms instead of numeric or implicit mappings.
- Accept small, local duplication when the alternative is coupling unrelated behavior.
- Add dependencies only when they remove more complexity than they introduce.
- Do not add architectural layers, factories, registries, or indirection without a present need.
- Write comments for motivation, constraints, or a bird's-eye view. Do not restate what the code says.

## Architecture vocabulary

Use these terms consistently:

- **Module**: implementation hidden behind one interface.
- **Interface**: everything a caller must know, including invariants and failure modes.
- **Seam**: where behavior can vary without editing the caller.
- **Adapter**: a concrete implementation at a seam.
- **Depth**: leverage provided by an interface; deep modules hide substantial behavior behind a small interface.
- **Locality**: changes, bugs, knowledge, and verification concentrate in one place.
- **Leverage**: one small interface serves many callers and tests.

Apply these checks:

- The interface is the test surface. Test observable behavior, not private implementation.
- Use the deletion test: deleting a useful module should force complexity into several callers.
- One adapter is a hypothetical seam. Introduce a seam when at least two adapters are justified.
- Accept dependencies from callers rather than constructing hard-to-test dependencies internally.
- Return results where practical; keep side effects concentrated.

## Product constraints

These are requirements, not suggestions:

- The private alpha targets Obsidian Desktop on Linux x86_64.
- Runs are user-triggered. There are no background agents.
- Inference is local and offline through a managed llamafile process.
- The model process binds to loopback only and is never exposed to the LAN.
- Agents have no network, shell, or raw-filesystem tools.
- Vault access goes through Obsidian's Vault and MetadataCache interfaces.
- `General` may read visible Markdown across the vault. `Journal` is restricted to its configured journal folder and explicitly attached notes.
- Scope is enforced by tool implementation, never only by prompts.
- New files default to `Agent Drafts/` and include minimal provenance.
- Every write requires a visible diff and explicit approval.
- Recheck source content before applying a change; stale proposals must fail safely.
- Templates use a separate protected approval flow.
- Findings cite source notes and excerpts. Interpretive inconsistencies are presented as possibilities, never facts.
- Conversation history becomes context only when explicitly resumed. Vault notes are the only durable agent memory.
- Retrieval starts with links, metadata, and bounded full-text search. Do not add embeddings until evidence justifies them.
- Llamafiles come only from the bundled catalog, with pinned URLs, checksums, licenses, and resource metadata.
- No automatic cloud or model fallback. Failures stop visibly without changing files.

## Change discipline

- Build one vertical behavior at a time.
- Keep policy decisions near the operations they govern.
- Prefer one readable orchestration path over event chains and pass-through modules.
- Add an interface only where it hides meaningful complexity or enables a real second adapter.
- Keep framework-specific Obsidian code outside core decision logic, but do not create ceremonial layers.
- Update this file when a durable engineering rule changes.
- Record load-bearing architectural decisions in `docs/adr/`; do not use ADRs for temporary preferences.

## Verification

- Test scope enforcement, approval requirements, stale-write rejection, cancellation, and failure safety.
- Use synthetic vault data in tests. Never require a real personal vault.
- Tests should survive internal refactors when the module interface and behavior remain unchanged.
- A model or sidecar compatibility test must not read or modify the user's vault.
