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
- Nazar runs [pi](https://pi.dev) in RPC mode as a child process. The plugin agent has the same capabilities as `pi` run interactively in the vault: same tools, same config discovery, same model layer, same trust machinery. See `docs/adr/0001-rpc-parity.md`.
- Runs are user-triggered. One run at a time. There is no resident agent process between runs.
- Inference, model selection, tools, extensions, skills, and project trust are delegated to pi. Nazar owns none of them.
- Conversations persist in pi's shared session store. Nazar tracks its own session lineage and never resumes another session implicitly.
- The plugin renders every tool execution visibly and provides cancel. There is no approval gate in the plugin; if one is ever needed it is built as a pi extension shared by TUI and plugin.
- Failures stop visibly. Missing `pi`, handshake failure, and protocol errors surface the binary tried and pi's stderr tail without changing files.
- The plugin binary lookup is an explicit path setting, then PATH, then the stable pi install locations; desktop sessions often do not inherit the shell PATH. Nothing else.

## Change discipline

- Build one vertical behavior at a time.
- Keep policy decisions near the operations they govern.
- Prefer one readable orchestration path over event chains and pass-through modules.
- Add an interface only where it hides meaningful complexity or enables a real second adapter.
- Keep framework-specific Obsidian code outside core decision logic, but do not create ceremonial layers.
- Update this file when a durable engineering rule changes.
- Record load-bearing architectural decisions in `docs/adr/`; do not use ADRs for temporary preferences.

## Verification

- Test session lineage tracking, streaming, cancellation, and visible failure paths.
- Integration tests spawn a real `pi` process against a synthetic vault and an isolated pi config dir with a fake model server. Never require a real personal vault.
- Tests should survive internal refactors when the module interface and behavior remain unchanged.
- Tests must not read or modify the user's vault or the user's real pi config.
