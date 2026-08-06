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
3. Keep every desktop and mobile support promise truthful.
4. Keep the whole system understandable by one maintainer.
5. Use Obsidian's public API and platform capabilities directly.
6. Minimize code, concepts, files, states, dependencies, and configuration.
7. Optimize performance only where measurement or a hard constraint justifies
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

Bolovan is a standalone git repository. It may be developed in place inside an
Obsidian vault or cloned independently in any ordinary folder on another
machine. In-vault development is a convenience, never an architectural
dependency.

Keep plugin source, tests, documentation, and commits inside this repository.
The project must build and test without access to SecondBrain, a parent vault,
personal notes, device-local settings, credentials, globally installed project
tools, or undocumented files outside the checkout. Treat any surrounding vault
as user data: do not inspect or modify it to develop or test the plugin.

The vault's portable runtime instructions belong in its configured Bolovan
brain folder, not in this file. This file is exclusively for coding harnesses
working on the plugin.

## Project map

- `src/main.ts` — plugin lifecycle, device-local settings, and settings UI
- `src/bolovan-agent.ts` — harness orchestration and tool loop
- `src/model-tools.ts` — model-facing tool definitions, invocation, results, and error policy
- `src/model-adapter.ts` — the OpenAI-compatible model adapter
- `src/brain-store.ts`, `src/skills.ts` — portable brain persistence and canonical Agent Skills
- `src/vault-tools.ts` — bounded Markdown/Canvas/Bases discovery, inspection, and approval-gated changes
- `src/structured-files.ts` — Canvas and Bases parsing, bounded inspection, and validation
- `src/workspace-tools.ts` — active-editor context and safe vault-file navigation
- `src/chat-view.ts`, `src/composer.ts`, `src/context.ts` — user interface and note attachments
- `src/transcript.ts` — portable transcript semantics
- `tests/` — unit, integration, and built-plugin smoke tests
- `docs/adr/` — load-bearing architecture decisions

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. Read `docs/agents/issue-tracker.md` before fetching, publishing, triaging, or linking tickets.

### Triage labels

Use the canonical triage labels configured in `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain-doc layout. Read `docs/agents/domain.md` before domain modeling or turning plans into tracker work.

## Development workflow

- Use Node.js 22.19 or newer.
- Run `npm test` for a complete verification pass.
- Run `npm run build` for a typecheck and production bundle.
- Keep setup reproducible from a fresh standalone clone using the documented
  Node.js version and lockfile.
- Do not use the surrounding personal vault, live credentials, or provider
  accounts as test fixtures.
- Use a disposable synthetic or dedicated development vault for runtime
  integration checks on every machine.
- Keep generated output and dependency changes intentional. If dependencies
  change, update and review `package-lock.json` with `package.json`.
- Review Obsidian's official sources before building any new feature, during
  code review, and before optimizing: the API type definitions and plugin
  guidelines at https://github.com/obsidianmd/obsidian-api and the developer
  documentation at https://docs.obsidian.md. Prefer the documented Obsidian
  API over a hand-rolled equivalent, and the current API over a deprecated one.

Sources:

- [Cognitive load guidance for agents](https://github.com/zakirullin/cognitive-load/blob/main/README.agents.md)
- [Cognitive Load Is What Matters](https://github.com/zakirullin/cognitive-load)
- [Obsidian API type definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [Obsidian developer documentation](https://docs.obsidian.md/Home)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)

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
- Hidden configuration is the justified `Vault.adapter` exception. Resolve it
  through `Vault.configDir`; never assume the directory is named `.obsidian`.
- Expose configuration work as explicit capabilities, not unrestricted adapter
  access. Supported capabilities include reading Bolovan's own directory and
  creating or modifying Obsidian themes, CSS snippets, and specifically named
  settings.
- Every model-initiated configuration mutation gets an exact preview, explicit
  approval, a stale-state check, and a recoverable path where practical.
- Other plugins' configuration, secrets, and unrelated hidden files are outside
  those capabilities. Technical reach is not product authorization.

## Dependency budget

The default answer to a new external dependency is no. A new runtime dependency
is allowed only when every condition below is met:

1. It enables an essential, already-approved user outcome.
2. Obsidian and Web Platform APIs cannot provide the capability.
3. A small local implementation would be materially riskier or more complex.
4. Its license, maintenance, security surface, mobile support, transitive graph,
   initialization cost, and shipped bundle cost have been reviewed.
5. It is isolated behind the narrowest practical boundary and loaded only when
   needed.
6. Its removal or replacement path can be explained briefly.
7. The justification is recorded in the PR or a load-bearing ADR.

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
- Reject convenience helpers, state frameworks, formatting packages,
  dependency-injection libraries, and thin wrappers over native APIs.

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

## Comprehension budget

"Fits in one head" is enforced through navigation and concepts, not line-count
limits:

- Keep the runtime architecture explainable on one page in roughly ten named
  concepts or fewer.
- Keep a common user action traceable through no more than four production
  modules.
- A routine feature should normally change one policy-owning module plus its
  tests.
- A change spanning four or more production modules triggers an explicit
  simplification review.
- A new module must hide substantial complexity or represent a genuinely
  distinct product concept.
- A fresh maintainer or focused LLM must be able to reconstruct the end-to-end
  system in one working session from this file, `CONTEXT.md`, and the main
  orchestration path.

Crossing a threshold is an alarm, not an automatic rejection. Simplify first;
if the intrinsic complexity remains, record a short architectural justification.
Never split code merely to meet a size metric.

## Product constraints

These are requirements, not suggestions:

- Target Obsidian 1.13.4 or newer. The core remote harness, vault and
  configuration capabilities, conversations, and approvals are supported on
  desktop, iOS, and Android. Do not import Node built-ins or depend on native
  processes.
- Bolovan owns its harness. Model configuration lives behind `ModelAdapter`; Obsidian behavior lives behind the small model-facing tool interface defined in `docs/adr/0001-native-cross-platform-harness.md`.
- The only supported model configuration is a single OpenAI-compatible
  endpoint. The bundled model runtime was removed in v0.4; reintroducing it
  requires the full dependency admission test again.
- Runs are user-triggered and single-flight. Completed-response rendering is the portable guarantee; streaming is optional enhancement behavior.
- Vault behavior uses Obsidian `Vault`, `MetadataCache`, and `FileManager` APIs.
  Hidden configuration capabilities use the mobile-safe `Vault.adapter` only
  through `Vault.configDir` and explicit path-bounded actions.
- Canvas and Bases remain visible vault files behind the existing vault tools.
  Preserve unknown structured keys and validate the complete resulting
  `.canvas` JSON or `.base` YAML before approval. Obsidian owns Bases formula
  evaluation; without a public standalone query interface, use `vault_search`
  for supported transient filters instead of a parallel evaluator or a
  temporary Base mutation.
- Every model-initiated change to user-authored content, vault structure, or
  Obsidian configuration requires an exact preview and explicit approval. The
  commit rechecks stale state; stale approvals write nothing.
- Deterministic plugin-owned persistence—settings, device identity, brain
  manifest, branch metadata, and conversation transcripts—does not require a
  separate approval. It stays in documented locations, and model output never
  chooses its destination or operation.
- The portable brain is a visible configurable vault folder identified by `bolovan-brain.json`. Secrets, model endpoint configuration, caches, device identity, and approval state stay device-local.
- Portable general instructions live in root `<Brain>/AGENTS.md`. Agent Skills
  live in visible `<Brain>/Skills/<name>/SKILL.md`, disclose metadata before
  instructions, load bounded resources on demand, and never execute bundled
  scripts or grant tools.
- Conversation files are device-owned branches. Never append to another device's branch and never automatically merge sync conflicts.
- Stop ends Bolovan's processing immediately: late provider responses cannot
  update the transcript, execute tools, or resume the run. The portable contract
  does not claim that `requestUrl` terminates the underlying HTTP request.
- `web_search`, shell access, raw unrestricted filesystem access, and external
  brain folders are outside the stable milestone. Plugin self-modification stays
  sealed; reading Bolovan's own source and approved Obsidian customization are
  explicit configuration capabilities.

## Change discipline

- Build one vertical behavior at a time.
- Keep policy decisions near the operations they govern.
- Prefer one readable orchestration path over event chains and pass-through modules.
- Add an interface only where it hides meaningful complexity or enables a real second adapter.
- Keep framework-specific Obsidian code outside core decision logic, but do not create ceremonial layers.
- Keep full-vault search as a direct scan until a reproducible desktop and
  mobile benchmark shows it violates the interaction budget. Cap results,
  remain cancellable, and avoid blocking the interface. Any later index must be
  disposable and derived entirely from vault state.
- Update this file when a durable engineering rule changes.
- Record load-bearing architectural decisions in `docs/adr/`; do not use ADRs for temporary preferences.
- Keep `.tours/` truthful: use the `codetour-truth` skill whenever a change touches a tour target or described behavior.

## Verification

- Test provider normalization, tool-loop stopping, cancellation, exact approvals, stale-write rejection, and device-branch forking through module interfaces.
- Test bounded and paginated reads, Markdown/Canvas/Bases inspection, structured-file validation, cancellable scans, workspace navigation that preserves the chat leaf, and native copy/trash through module interfaces.
- Test root Brain instructions, strict Agent Skills discovery, progressive
  activation, bounded package resources, grouped diagnostics, approved skill
  authoring, and explicit wikilink activation through module interfaces.
- Transcript semantics live in `src/transcript.ts` and are tested without an Obsidian runtime.
- Integration tests use synthetic in-memory adapters and never a personal vault, credential, or provider account.
- Release smoke tests cover the minimum supported Obsidian version, current
  desktop, iOS, and Android for the core harness.
- Tests should survive internal refactors when module interfaces and behavior remain unchanged.
