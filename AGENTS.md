# Bolovan engineering guide

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

- Target Obsidian 1.13.4 or newer on every supported desktop and mobile platform. Do not import Node built-ins or depend on native processes.
- Bolovan owns its harness. Providers vary behind `ModelAdapter`; Vault behavior varies behind the four-tool adapter. See `docs/adr/0001-native-cross-platform-harness.md`.
- Supported providers are OpenAI, advanced OpenAI-compatible endpoints, and local Transformers.js WebGPU. Local inference has no CPU/WASM fallback.
- Runs are user-triggered and single-flight. Completed-response rendering is the portable guarantee; streaming is optional enhancement behavior.
- Vault access uses only Obsidian `Vault`, `MetadataCache`, and `FileManager` APIs. Stable exposes only `vault_read`, `vault_search`, `vault_list`, and `vault_change`.
- Every mutation requires an exact preview and explicit approval. The commit rechecks the source hash; stale approvals write nothing.
- The portable brain is a visible configurable vault folder identified by `bolovan-brain.json`. Secrets, provider profiles, caches, device identity, and approval state stay device-local.
- Conversation files are device-owned branches. Never append to another device's branch and never automatically merge sync conflicts.
- `web_search`, shell access, raw filesystem access, external brain folders, and plugin self-modification are outside the stable milestone.

## Change discipline

- Build one vertical behavior at a time.
- Keep policy decisions near the operations they govern.
- Prefer one readable orchestration path over event chains and pass-through modules.
- Add an interface only where it hides meaningful complexity or enables a real second adapter.
- Keep framework-specific Obsidian code outside core decision logic, but do not create ceremonial layers.
- Update this file when a durable engineering rule changes.
- Record load-bearing architectural decisions in `docs/adr/`; do not use ADRs for temporary preferences.

## Verification

- Test provider normalization, tool-loop stopping, cancellation, exact approvals, stale-write rejection, and device-branch forking through module interfaces.
- Transcript semantics live in `src/transcript.ts` and are tested without an Obsidian runtime.
- Integration tests use synthetic in-memory adapters and never a personal vault, credential, provider account, or downloaded model.
- Tests should survive internal refactors when module interfaces and behavior remain unchanged.
