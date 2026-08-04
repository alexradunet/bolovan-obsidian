# Bolovan engineering mythos

Bolovan must remain small enough that one person—or one LLM with a focused
context—can understand the whole project. This is a product requirement, not an
aesthetic preference.

Write code for human working memory. A reader should rarely need to hold more
than four facts at once to understand a change. The best implementation is the
smallest unsurprising one that completely solves the important problem.

## Order of values

When principles compete, decide in this order:

1. Preserve user data and explicit approval boundaries.
2. Deliver the vital user outcome—the 20% of behavior that creates 80% of the
   value.
3. Keep the whole system understandable by one maintainer.
4. Use Obsidian's public API and platform capabilities directly.
5. Minimize code, concepts, files, states, dependencies, and configuration.
6. Optimize performance only where measurement or a hard constraint justifies
   it.

Do not trade simplicity for theoretical flexibility, architectural fashion, or
a future requirement that does not exist.

## The Pareto rule

- Find the smallest end-to-end behavior that delivers most of the user value.
- Build that path completely before adding variants, knobs, or abstractions.
- Prefer one excellent common path over many mediocre edge-case paths.
- Let rare cases fail clearly when supporting them would make the common path
  substantially harder to understand.
- Delete or decline features whose maintenance cost exceeds their demonstrated
  value.
- Every new concept must earn its place. If removing it barely reduces product
  value, remove it.
- A smaller codebase is not merely easier to maintain; it is a core capability
  because a person or agent can reason about it as one system.

## Repository scope

This directory is Bolovan's standalone git repository, even though it is
developed in place inside an Obsidian vault. Keep plugin source, tests,
documentation, and commits inside this repository. Treat the surrounding vault
as user data: do not inspect or modify personal notes to develop or test the
plugin.

The vault's portable runtime instructions belong in its configured Bolovan
brain folder, not in this file. This file is exclusively for coding harnesses
working on the plugin.

## Project map

- `src/main.ts` — plugin lifecycle, device-local settings, and settings UI
- `src/bolovan-agent.ts` — harness orchestration and tool loop
- `src/model-adapter.ts` — remote and local provider adapters
- `src/brain-store.ts` — portable brain and conversation persistence
- `src/vault-tools.ts` — the four Obsidian-native vault tools and approvals
- `src/chat-view.ts`, `src/composer.ts`, `src/context.ts` — user interface and note attachments
- `src/transcript.ts` — portable transcript semantics
- `tests/` — unit, integration, and built-plugin smoke tests
- `docs/adr/` — load-bearing architecture decisions

## Development workflow

- Use Node.js 22.19 or newer.
- Run `npm test` for a complete verification pass.
- Run `npm run build` for a typecheck and production bundle.
- Do not use the surrounding personal vault, live credentials, downloaded
  models, or provider accounts as test fixtures.
- Keep generated output and dependency changes intentional. If dependencies
  change, update and review `package-lock.json` with `package.json`.

Sources:

- [Cognitive load guidance for agents](https://github.com/zakirullin/cognitive-load/blob/main/README.agents.md)
- [Cognitive Load Is What Matters](https://github.com/zakirullin/cognitive-load)

## Prime directive

Reduce extraneous cognitive load. Prefer boring, direct code whose behavior is
visible locally. Optimize for the person debugging this six months from now.

Familiarity is not simplicity. Review code as if seeing it for the first time.
If understanding a change requires reconstructing hidden conventions, chasing
several pass-through layers, or learning a private architectural vocabulary,
the design is too expensive.

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

## Obsidian first

Bolovan is an Obsidian plugin, not a framework around Obsidian.

- Before writing infrastructure or adding a package, check whether the Obsidian
  API already provides the capability.
- Use public Obsidian APIs to their fullest extent, especially `Vault`,
  `MetadataCache`, `FileManager`, `Workspace`, `SecretStorage`, settings,
  commands, views, menus, notices, and lifecycle registration.
- Use Obsidian abstractions instead of Node filesystem APIs, browser-storage
  substitutes, parallel metadata indexes, or custom lifecycle systems.
- Do not duplicate state that Obsidian already owns. Derive it from Obsidian at
  the point of use unless caching has a measured benefit and clear invalidation.
- Respect Obsidian lifecycle and cleanup facilities. Register resources through
  the plugin APIs so unloading the plugin leaves nothing behind.
- Keep domain decisions testable without Obsidian, but do not wrap Obsidian in
  ceremonial interfaces. Add a boundary only when it isolates meaningful logic
  or enables a real test seam.
- Target the public API of the minimum supported Obsidian version. Do not depend
  on undocumented internals simply to save a few lines.

## Dependency budget

The default answer to a new external dependency is no.

- Treat every dependency as source code Bolovan must understand, ship, update,
  audit, and debug.
- Prefer the Obsidian API, Web Platform APIs, and a small local implementation,
  in that order.
- Add a runtime dependency only when it supplies an essential capability that
  would be riskier or materially more complex to implement locally.
- Do not add a package for convenience helpers, data structures, formatting,
  state management, dependency injection, or a thin wrapper over a native API.
- Consider bundle size, transitive dependencies, mobile compatibility,
  initialization cost, security surface, and long-term maintenance together.
- A little obvious duplication is cheaper than a shared abstraction or package
  that couples unrelated behavior.
- Remove dependencies that no longer justify their cost.
- Keep provider-specific heavy dependencies behind the narrowest practical
  boundary and load them only when their provider needs them.

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
