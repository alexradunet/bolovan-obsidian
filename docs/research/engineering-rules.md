# Research: engineering rules for Bolovan

Research date: 2026-08-04  
Decision record updated: 2026-08-05

## Question and method

What coding rules let Bolovan remain a small, understandable, Pareto-focused Obsidian plugin while it safely supports remote models on desktop and mobile?

This note distinguishes facts owned by primary sources from recommendations inferred for Bolovan. Sources are limited to Obsidian's documentation and public API definitions, the two author-owned cognitive-load documents requested for the project's mythos, and the Bolovan repository itself.

## Executive conclusion

The current direction is sound, but the slogans need precise boundaries.

Bolovan should optimize the common end-to-end user outcome, not literal line count. It should use public Obsidian APIs directly wherever they own the behavior and reject convenience dependencies. Safety, platform support, and truthful product promises are not Pareto-discardable edge cases.

"Fits in one head" is best enforced by few product concepts, local control flow, a short architectural reading path, and small interfaces around genuinely complex capabilities. Arbitrary function or file-size limits would work against the cited cognitive-load guidance.

The follow-up design interview resolved the ambiguous boundaries. Bolovan will
use approval based on ownership, expose path-bounded Obsidian customization
capabilities, make the core harness a tested desktop/iOS/Android promise, admit
dependencies only through an evidence test, retain scan-first search, promise
processing rather than network cancellation, and enforce a concrete
comprehension budget.

## Source-backed facts

### 1. Obsidian is the primary platform boundary

- Obsidian exposes `App`, `Vault`, `Workspace`, `MetadataCache`, `FileManager`, `SecretStorage`, plugin lifecycle registration, commands, settings, and views as public plugin APIs. The official API repository also says external dependencies must be bundled into `main.js`. [Obsidian API repository](https://github.com/obsidianmd/obsidian-api) and [public type definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- Obsidian's review guidance prefers `Vault` over `Vault.adapter`: `Vault` adds caching and serializes operations to avoid races. It recommends `Vault.process()` for background edits, `Editor` for edits to an active note, `FileManager.processFrontMatter()` for frontmatter, `FileManager.trashFile()` for user-respecting deletion, `normalizePath()` for user-provided paths, and direct path lookup instead of scanning all files to find one path. [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- The Vault guide distinguishes `cachedRead()` for display from `read()` for read-modify-write work. It says `Vault.process()` atomically reads, modifies, and saves a file, and recommends it over separate reads and writes to avoid lost updates. It also confirms that hidden files are not visible through `Vault`; reaching them requires the Adapter API. [Vault guide](https://docs.obsidian.md/Plugins/Vault)
- Obsidian recommends `registerEvent()`, `registerDomEvent()`, and `registerInterval()` so resources are cleaned up when a plugin unloads. [Events guide](https://docs.obsidian.md/Plugins/Events) and [API repository lifecycle examples](https://github.com/obsidianmd/obsidian-api#registering-events)
- `requestUrl()` is Obsidian's cross-origin HTTP API. The current public `RequestUrlParam` contains URL, method, content type, body, headers, and error behavior, but no `AbortSignal`. [Public type definitions](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) The official mobile review checklist tells mobile-compatible plugins to use `requestUrl` instead of `fetch` or Axios. [Official plugin self-review checklist](https://docs.obsidian.md/oo/plugin)
- `SecretStorage` is the public API intended for secrets such as API keys. The official guide says plugin settings should hold the secret's name while the secret value remains in Obsidian's vault-specific local storage; it does not claim the value is portable vault content. [Secret storage guide](https://docs.obsidian.md/plugins/guides/secret-storage)

### 2. Mobile and release status impose real constraints

- `manifest.json` uses `isDesktopOnly` to declare whether a plugin uses Node.js or Electron APIs. Bolovan declares `false`, so mobile compatibility is a product claim, not merely an implementation preference. [Manifest reference](https://docs.obsidian.md/Reference/Manifest) and the local [manifest](../../manifest.json)
- Obsidian's official self-review checklist tells mobile plugins not to assume Node/Electron, not to cast the adapter to `FileSystemAdapter`, to use `Platform` instead of `process.platform`, and to use `requestUrl` for networking. [Official plugin self-review checklist](https://docs.obsidian.md/oo/plugin)
- Obsidian warns that plugin development can unintentionally modify a vault and explicitly recommends a separate disposable development vault rather than a user's main vault. [Build a plugin](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin)
- Obsidian loads plugins before the user can interact with the app. Its performance guide recommends a production/minified bundle, a simple `onload()`, and deferring expensive startup work until layout is ready. [Optimize plugin load time](https://docs.obsidian.md/plugins/guides/load-time)
- Community-directory policy forbids client-side telemetry and self-updating plugin mechanisms. It requires README disclosure of network use, including which remote services are used and why, and requires compliance with licenses of reused code. [Developer policies](https://docs.obsidian.md/Developer+policies)
- Community releases install `main.js`, `manifest.json`, and optional `styles.css` from a GitHub release whose tag matches the manifest version. [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)

### 3. The cognitive-load documents support simplicity, not tiny-code dogma

- The requested essay defines cognitive load informally as how much a developer must think to complete a task. It advocates named intermediate conditions, early returns, composition, deep modules with small interfaces, a limited language subset, self-describing values, restrained DRY, and avoiding unjustified architectural layers. It explicitly rejects arbitrary small-method/module rules. [Cognitive Load Is What Matters](https://github.com/zakirullin/cognitive-load/blob/main/README.md)
- The agent-specific version turns those ideas into direct coding guidance: comments should explain motivation or a bird's-eye view, complex conditions should be named, early returns should expose the happy path, and a little duplication can be cheaper than a dependency. [Cognitive-load guidance for agents](https://github.com/zakirullin/cognitive-load/blob/main/README.agents.md)
- The essay itself cautions that its working-memory model is deliberately informal. Therefore, "four chunks" is useful as a review metaphor, not a scientifically precise acceptance test. [Cognitive Load Is What Matters](https://github.com/zakirullin/cognitive-load/blob/main/README.md#cognitive-load)

## Bolovan repository observations

These are direct observations of the repository on the date above, not claims made by external sources.

- The stable product is intentionally a narrow harness: one normalized model interface and four vault tools, with shell, arbitrary filesystem access, web search, and plugin self-modification out of scope. [ADR 0001](../adr/0001-native-cross-platform-harness.md)
- The source is currently ten TypeScript modules. Most of the system can be read in this order: [main](../../src/main.ts) → [agent loop](../../src/bolovan-agent.ts) → [model adapter](../../src/model-adapter.ts) and [vault tools](../../src/vault-tools.ts) → [brain store](../../src/brain-store.ts) → UI and transcript modules. This is already a short architectural path.
- The plugin already uses many appropriate public APIs directly: `requestUrl`, `SecretStorage`, `Platform`, lifecycle registration, `Vault.process`, `normalizePath`, and `FileManager.renameFile`.
- There is one intentional Adapter exception: `vault_read` and `vault_list` let the model inspect `.obsidian`, because hidden files are unavailable through `Vault`. Writes to `.obsidian` are blocked. [Vault tools](../../src/vault-tools.ts)
- Model-initiated `replace` and `append` operations use exact preview plus a second in-process content check through `Vault.process`. Moves and archives recheck a SHA-256 before `FileManager.renameFile`. [Vault tools](../../src/vault-tools.ts)
- The plugin also creates and modifies its own brain manifest, instructions, and conversation files without a per-write approval. Conversation updates currently use `Vault.modify`, not `Vault.process`. [Brain store](../../src/brain-store.ts)
- The manifest carries no runtime dependencies; only development tooling is installed. Install-graph size and shipped-bundle size should be reviewed separately. [Package manifest](../../package.json) and [build configuration](../../esbuild.config.mjs)
- Unit tests cover transcript behavior, context, model adaptation, and vault mutation checks; a built-plugin smoke test checks that the bundle loads with an Obsidian stub. There is no automated real-Obsidian desktop/mobile test in the current suite. [Tests](../../tests/)

## Recommendations and inferences for the engineering mythos

The remainder is prescriptive interpretation for Bolovan. It is not presented as Obsidian policy.

### 1. Keep an explicit order of values

Use this order when rules conflict:

1. Preserve user data, secrets, privacy, and approval boundaries.
2. Deliver the smallest complete user outcome.
3. Keep desktop/mobile behavior truthful and portable.
4. Keep the whole product model understandable by one maintainer or one focused LLM context.
5. Use public Obsidian APIs, then Web Platform APIs, then small local code.
6. Minimize dependencies, concepts, files, states, and configuration.
7. Optimize measured bottlenecks.

This prevents "Pareto" or "fewer dependencies" from becoming excuses to weaken data safety, reimplement concurrency incorrectly, or silently abandon mobile.

### 2. Make Pareto a product-scope rule

Treat 80/20 as a prioritization heuristic, not a factual ratio that each feature must prove.

- Every feature proposal should name one user outcome, its common path, and explicit non-goals.
- Finish the common path end-to-end before adding variants or configuration.
- Prefer a clear refusal with recovery guidance for a rare unsupported case.
- Delete a feature or option when removing it barely changes the core outcome.
- Never classify data loss, secret leakage, stale writes, misleading consent, or a claimed supported platform as an "edge case."

### 3. Define "fits in one head" by concepts and navigation

Do not impose line-count, function-count, or file-size limits. Instead require:

- A new maintainer can draw the runtime in a few boxes after reading the project map and the main orchestration path.
- A behavior change normally touches one policy-owning module plus tests, not several pass-through layers.
- Interfaces hide real complexity and state their invariants and failure modes.
- Important orchestration may be long when keeping it together makes the control flow locally visible.
- A new abstraction must either hide substantial complexity, isolate an actual volatile boundary, or support a second justified implementation.

The practical budget is the number of concepts and jumps needed to explain a change, not raw lines of code.

### 4. Interpret "Obsidian first" as responsible API ownership

- Use a public Obsidian API whenever Obsidian owns the lifecycle, vault, workspace, metadata, settings, secret, network, command, view, or UI behavior.
- Use `Vault.process` for background read-modify-write operations, including plugin-owned JSON when it may race with sync or another process.
- Keep the Adapter API exceptional and documented. "Public" alone is insufficient: an Adapter operation should also be necessary, mobile-safe, narrowly path-bounded, and consistent with the product's privacy promise.
- Resolve hidden configuration through `Vault.configDir`, not a hardcoded
  `.obsidian` path. Expose explicit actions for reading Bolovan's own directory
  and creating or modifying themes, CSS snippets, and specifically supported
  settings. Do not expose unrestricted configuration-directory access.
- Do not wrap Obsidian in ceremonial interfaces. Add a seam where domain behavior can be tested without a live vault or where a real second implementation exists.
- Pin `minAppVersion` to the oldest API actually used and test that version or change the declared minimum.
- Do not use undocumented internals, global `app`, Node built-ins, Electron, raw OS paths, or native subprocesses in the portable product.

"Maximum capabilities" should mean maximum leverage from stable public APIs, not maximum access to everything an API technically permits.

### 5. Give dependencies two budgets and one exception test

Review install-time dependencies and shipped runtime artifacts separately.

A new runtime dependency is allowed only when all are true:

1. It provides an essential product capability unavailable from Obsidian or the Web Platform.
2. Reimplementing it would be materially riskier or more complex.
3. Its license, maintenance status, transitive graph, security surface, mobile behavior, initialization cost, and bundle/model artifacts have been inspected.
4. It sits behind the narrowest practical boundary and loads only when needed.
5. Its exact version is pinned when compatibility is sensitive, and the lockfile is reviewed.
6. A removal or replacement path is clear enough to describe in a few sentences.


### 6. Make safety boundaries semantic

Replace the ambiguous phrase "every mutation requires approval" with a rule that distinguishes ownership:

- Every **model-initiated change to user-authored vault content, vault
  structure, or Obsidian configuration** requires an exact preview, explicit
  approval, and a stale-state recheck.
- Predictable **plugin-owned persistence** needed to perform a user action—settings, device identity, branch metadata, and conversation transcripts—may write without approval, but only inside documented locations and never by interpreting model output as a destination or operation.
- Destructive operations should use recoverable Obsidian behavior where possible.
- No approval may authorize a different path or content after the preview; stale approval writes nothing.
- Network requests should disclose destination, purpose, and what user/vault content is sent. Secrets must never enter transcripts, model prompts, logs, or portable files.

### 7. Test promises and seams, not private structure

- Preserve fast unit tests for normalization, tool-loop stopping, approval state, stale-write rejection, branch ownership, and transcript semantics.
- Keep a built-bundle smoke test because bundling is part of an Obsidian plugin's runtime contract.
- Use only disposable synthetic vaults for development and integration tests.
- Add a small release smoke matrix for the minimum supported Obsidian version,
  current desktop, iOS, and Android while `isDesktopOnly: false` remains a hard
  support promise.
- Exercise remote-provider failure and sync-conflicted branch state. A provider happy path cannot establish cross-device compatibility by itself.
- Measure plugin startup and bundle/runtime artifact size at releases; do not optimize speculative micro-costs.

## Decisions confirmed in the design interview

1. **Approval follows ownership.** Every model-initiated change to user-authored
   content, vault structure, or Obsidian configuration needs an exact preview,
   explicit approval, and stale-state recheck. Deterministic plugin-owned
   persistence in documented locations does not.
2. **Configuration access is capability-specific.** Bolovan may read its own
   plugin directory and create or modify themes, CSS snippets, and explicitly
   supported Obsidian settings. It uses `Vault.configDir`, prefers higher-level
   APIs, and never receives unrestricted hidden-directory access.
3. **Core mobile support is a tested promise.** Remote inference, vault and
   configuration tools, conversations, and approvals require desktop, iOS, and
   Android smoke coverage.
4. **Dependencies require evidence.** A runtime dependency must enable an
   approved essential outcome unavailable from Obsidian or the Web Platform;
   be safer than local code; pass license, maintenance, security, mobile,
   transitive, and bundle review; stay narrowly lazy; describe its removal path;
   and record the justification. Convenience packages are rejected.
5. **Search remains scan-first.** Indexing requires a reproducible desktop and
   mobile benchmark showing direct scanning violates an agreed interaction
   budget. Any index is disposable derived state.
6. **Cancellation claims are honest.** Stop ends processing immediately and
   rejects late results. It does not promise to terminate an underlying
   `requestUrl` request, though an adapter may do so where supported.
7. **Comprehension has review alarms.** Keep the architecture to roughly ten
   named concepts on one page, common actions within four production modules,
   and routine changes within one policy module plus tests. Crossing four
   production modules triggers simplification review or a short justification;
   no arbitrary code-size limits apply.

## Recommended concise rule

> Build the smallest complete Bolovan that safely serves the common vault and
> Obsidian-customization workflows on every platform we claim. Prefer stable
> public Obsidian APIs, then Web Platform APIs, then obvious local code. Reject
> dependencies and abstractions by default; admit an exception only when it
> hides essential complexity behind a small, lazy, testable boundary. Keep
> model-initiated changes previewed, approved, and stale-safe. Optimize for a
> maintainer who must reconstruct the whole system in one focused sitting.
