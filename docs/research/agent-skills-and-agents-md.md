# Research: Agent Skills and AGENTS.md for Bolovan

Research and source access date: 2026-08-06  
Scope: the open Agent Skills format, first-party implementations, the AGENTS.md open format, and a minimal Bolovan adoption profile

## Executive conclusion

The canonical Agent Skills file is **`SKILL.md`**, singular and with that exact uppercase casing. **`SKILLS.MD` is not canonical** and should not be accepted as the standards-compliant filename. A skill is a directory whose required `SKILL.md` combines constrained YAML frontmatter with a Markdown instruction body; scripts, references, and assets are optional resources loaded progressively. The format specification defines the contents of a skill but deliberately does not mandate where skill directories are installed.

The canonical project-instruction filename is **`AGENTS.md`**. It is ordinary Markdown with no required headings or frontmatter. A root file provides repository-wide guidance; nested files specialize guidance for subtrees, with the closest file taking precedence according to the open-format site. Actual clients differ in discovery and merging details, so Bolovan must define and document its own deterministic behavior rather than infer universal semantics that do not exist.

The two formats are complementary:

- `AGENTS.md` supplies broad, usually always-on instructions for work in a directory tree.
- Agent Skills package named, reusable capabilities that are cataloged cheaply, activated only when relevant, and may carry executable resources.

Bolovan currently implements neither format at runtime. It instead loads `<Brain>/Instructions.md` plus all Markdown below case-sensitive `<Brain>/Skills/`, flattens them into one prompt payload, and documents one flat `<kebab-case>.md` skill per file. Adopting the standards therefore requires a deliberate migration rather than relabeling the current loader.

## Method and authority labels

This note uses primary sources only. Claims are labeled as follows:

- **Format requirement**: a `must` or required constraint in the canonical specification.
- **Open-format rule**: behavior stated by the canonical AGENTS.md site, which is an intentionally simple convention rather than a versioned RFC with conformance language.
- **Reference guidance**: advice from the standard's official integration or authoring guides; useful for compatibility, but not required for a skill directory to conform.
- **Product behavior/policy**: behavior of a named implementation such as Codex, GitHub Copilot, VS Code, Claude, or current Bolovan. It is not automatically part of either open format.
- **Bolovan recommendation**: a proposed local policy that the standards leave open.

Primary sources reviewed:

- [Agent Skills specification](https://agentskills.io/specification)
- [Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)
- [Agent Skills source repository](https://github.com/agentskills/agentskills)
- [OpenAI: Build skills](https://developers.openai.com/codex/skills/)
- [Anthropic: Use skills in Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude)
- [Canonical AGENTS.md site](https://agents.md/)
- [AGENTS.md source repository](https://github.com/agentsmd/agents.md)
- [OpenAI Codex: Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md/)
- [GitHub Copilot: Adding repository custom instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide)
- [VS Code: Use custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions)
- [Gemini CLI: Provide context with GEMINI.md files](https://geminicli.com/docs/cli/gemini-md/)
- [Obsidian Sync: selective syncing](https://obsidian.md/help/sync/settings)

## Current Bolovan behavior and gaps

Repository inspection found the runtime behavior in [BrainStore](../../src/brain-store.ts) and [BolovanAgent](../../src/bolovan-agent.ts), with coverage in [the agent tests](../../tests/bolovan-agent.test.ts):

- `BrainStore.instructions()` reads exact `<Brain>/Instructions.md`, then recursively reads every Markdown file under case-sensitive `<Brain>/Skills/`, path-sorts the results, wraps them by basename, joins them, and truncates the combined payload at 120,000 characters.
- The agent reloads this material on each loop round and injects it as raw instruction text. Its built-in authoring guidance describes flat `<kebab-case>.md` files, not one directory per skill.
- There is no `SKILL.md` frontmatter parser, name/directory validator, progressive metadata catalog, activation boundary, resource resolver, collision policy, or skill-specific trust gate. Structured-file validation currently concerns `.canvas` and `.base`, not skill Markdown.
- There is no runtime discovery or hierarchy for `AGENTS.md`. The repository's own root `AGENTS.md` is coding-harness guidance and explicitly separates itself from Bolovan runtime instructions.
- `.agents/skills/**/SKILL.md` and `skills-lock.json` in this repository are development-harness assets, not evidence that the Bolovan plugin implements Agent Skills.
- No `SKILLS.MD` occurrence was found.

The central mismatch is architectural: current Bolovan eagerly concatenates all skill content, while Agent Skills relies on progressive disclosure and activation. Supporting the standard should not preserve the eager concatenation under a new filename.

## Agent Skills: canonical format

### Exact filename and unit of packaging

**Format requirement:** A skill is a directory containing, at minimum, a file named exactly `SKILL.md`. The specification's directory example is `skill-name/SKILL.md`; `scripts/`, `references/`, and `assets/` are optional. Other files and directories are allowed. See the [directory structure in the specification](https://agentskills.io/specification#directory-structure).

Consequences for Bolovan:

- Accept `SKILL.md`; do not advertise `SKILLS.MD`, `skill.md`, or a flat `name.md` file as standard-conforming.
- On case-sensitive storage, only the exact spelling is conforming. A UI may diagnose likely casing mistakes, but silently treating them as conforming would hide portability errors.
- The parent directory is part of the skill identity because the required `name` must match it.

### Required frontmatter

**Format requirement:** `SKILL.md` must contain YAML frontmatter followed by Markdown content. The only required fields are `name` and `description`. See [`SKILL.md` format](https://agentskills.io/specification#skillmd-format).

`name` requirements from the [name field specification](https://agentskills.io/specification#name-field):

- 1–64 characters.
- Only lowercase ASCII letters `a-z`, digits `0-9`, and hyphens.
- Must not begin or end with a hyphen.
- Must not contain consecutive hyphens.
- Must match the parent directory name.

The specification table says “unicode lowercase alphanumeric” but immediately defines the allowed set as `a-z` and `0-9`; the detailed rule and examples reject uppercase. A portable validator should enforce the explicit ASCII set rather than interpret “unicode” broadly.

`description` requirements from the [description field specification](https://agentskills.io/specification#description-field):

- 1–1024 characters and non-empty.
- It describes what the skill does and when it should be used.

The recommendation to include specific trigger keywords is authoring guidance, not an additional syntactic requirement.

Optional standard fields are documented in the [frontmatter table](https://agentskills.io/specification#frontmatter):

- `license`: a license name or reference to a bundled license file.
- `compatibility`: 1–500 characters when present; communicates product, system package, network, or other environment requirements.
- `metadata`: a map from string keys to string values. Unique namespaced keys are recommended to avoid collisions.
- `allowed-tools`: a space-separated pre-approved tool list. It is explicitly **experimental**, so support varies and Bolovan must not treat it as a portable authorization guarantee.

**Compatibility implication:** The canonical specification defines these fields. Vendor-only metadata must not be mistaken for portable frontmatter. For example, OpenAI adds optional `agents/openai.yaml` for UI, invocation policy, and dependencies; that is documented [OpenAI product behavior](https://developers.openai.com/codex/skills/#optional-metadata), not an Agent Skills requirement.

### Markdown body

**Format requirement:** The body follows the closing YAML delimiter and contains the skill instructions. The specification places no format restrictions on that Markdown. Step-by-step instructions, examples, and edge cases are recommended sections, not required headings. See [body content](https://agentskills.io/specification#body-content).

**Reference guidance:** Because the entire `SKILL.md` is loaded on activation, longer details should move to referenced files. The specification recommends keeping `SKILL.md` below 500 lines and its instruction tier below about 5,000 tokens. These are context-efficiency recommendations, not conformance limits. See [progressive disclosure](https://agentskills.io/specification#progressive-disclosure).

### Optional resource conventions

The standard permits arbitrary additional files. The named directories below are recommended organization conventions, not requirements:

- `scripts/`: executable code. Scripts should be self-contained or document dependencies, produce useful errors, and handle edge cases. Supported languages are client-dependent.
- `references/`: documentation loaded on demand. Focused files reduce context use.
- `assets/`: templates, images, lookup data, schemas, and other static resources.

See [optional directories](https://agentskills.io/specification#optional-directories).

**Reference guidance:** References should use paths relative to the skill root, remain one level deep where practical, and avoid chains in which one reference sends the agent through many more references. See [file references](https://agentskills.io/specification#file-references).

**Bolovan recommendation:** Resolve every resource path against the canonical skill directory, reject traversal outside that directory for automatic resource loading, and continue to subject any write, network, or execution action to Bolovan's normal approval and capability boundaries. A file being bundled in a skill is not user consent to execute it.

### Progressive disclosure

Progressive disclosure is the core interoperability model described by both the [specification](https://agentskills.io/specification#progressive-disclosure) and [official client implementation guide](https://agentskills.io/client-implementation/adding-skills-support#the-core-principle-progressive-disclosure):

1. **Catalog:** load each valid skill's `name` and `description` at session start, roughly 50–100 tokens per skill.
2. **Instructions:** load full `SKILL.md` only after the skill is selected for the task.
3. **Resources:** load referenced scripts, references, or assets only as needed.

OpenAI independently documents this behavior for ChatGPT and Codex: they initially expose name and description, then load the full file on use; Codex also includes the file path and budgets the initial list. That budget is [Codex product policy](https://developers.openai.com/codex/skills/), not a standard limit.

The official integration guide allows either file-read activation or a dedicated activation tool. A dedicated tool is particularly useful when the model cannot access arbitrary files and can enumerate valid names, enforce permission policy, return the skill root, and list resources without eagerly reading them. See [activation patterns](https://agentskills.io/client-implementation/adding-skills-support#step-4-activate-skills).

### Installation directories, scope, and collisions

**Not specified by the format:** The Agent Skills specification defines what is inside a skill, not where skills are installed.

**Reference guidance:** The official client guide recommends considering both client-specific paths and the cross-client `.agents/skills/` convention at project and user scope:

- `<project>/.agents/skills/`
- `~/.agents/skills/`
- optionally client-native equivalents

It calls `.agents/skills/` widely adopted rather than mandatory. It also notes optional compatibility paths such as `.claude/skills/`. See [where to scan](https://agentskills.io/client-implementation/adding-skills-support#where-to-scan).

The same guide recommends deterministic collision handling and describes project-level skills overriding user-level skills as a convention. Within one scope, it permits first-found or last-found if documented and warns the user. This is integration guidance, not format conformance.

OpenAI's implementation scans `.agents/skills` from the current working directory through repository root, plus user, admin, and bundled locations. It does **not** merge same-named skills and may display both, demonstrating that collision behavior is not fully interoperable across clients. See [Codex skill locations](https://developers.openai.com/codex/skills/#where-codex-loads-local-skills).

### Validation and leniency

**Format requirement:** A conforming skill satisfies the exact filename, required YAML, field types, name constraints, description constraint, and directory-name match above.

**Reference implementation:** The specification points to `skills-ref validate ./my-skill` in the [official `skills-ref` library](https://github.com/agentskills/agentskills/tree/main/skills-ref) to check frontmatter and naming conventions. See [validation](https://agentskills.io/specification#validation).

The official client guide separately recommends lenient loading for compatibility: warn but load on some cosmetic name violations; skip a skill with no usable description or wholly unparseable YAML. It explicitly says that leniency relaxes the strict specification. See [lenient validation](https://agentskills.io/client-implementation/adding-skills-support#lenient-validation).

**Bolovan recommendation:** Separate validation from loading:

- Authoring and import validation should be strict and actionable.
- Existing non-conforming local content may be diagnosed without blocking unrelated skills, but the UI must not label it conforming.
- Completely invalid YAML, missing `name`, or missing/empty `description` should exclude the skill from the model catalog, because safe and reliable activation is impossible.
- Never mutate imported content automatically to “repair” YAML without showing the user the exact change.

### Security and trust

The format carries both instruction text and potentially executable code. Conformance is not a trust signal.

The official client guide advises gating project-level skills on workspace trust because a newly cloned repository may otherwise inject instructions silently. It also recommends bounded discovery to avoid runaway scans. See [trust considerations and scanning bounds](https://agentskills.io/client-implementation/adding-skills-support#step-1-discover-skills).

Anthropic identifies prompt injection and data exfiltration as the principal skill risks, notes that skills can include or request third-party packages, and says to install only from trusted sources. For less-trusted skills, it directs users to inspect bundled files, dependencies, images, scripts, and instructions or code that connect to external networks. See [Anthropic's privacy and security guidance](https://support.claude.com/en/articles/12512180-use-skills-in-claude#privacy-and-security-details).

**Bolovan product policy should therefore:**

- Treat repository, shared, downloaded, and user-authored skills as untrusted content until the user establishes trust.
- Parse metadata without executing or following the body.
- Never convert `allowed-tools` into authorization; it is experimental metadata authored by the skill itself.
- Preserve Bolovan's existing approvals for writes and other consequential actions.
- Add a distinct approval boundary before executing bundled scripts or installing dependencies if Bolovan ever exposes execution.
- Keep network access denied unless an existing user-approved tool call permits it; reject a skill's attempt to broaden the tool set.
- Show provenance, source path, shadowing/collisions, validation diagnostics, and whether a skill has scripts or external requirements.
- Avoid blanket allowlisting of skill directories merely to suppress prompts. The integration guide suggests allowlisting for flow, but that convenience conflicts with a least-privilege host unless resource reads are already narrowly sandboxed.

## AGENTS.md: canonical convention

### Filename, placement, scope, and format

The canonical filename is **`AGENTS.md`**. The [open-format site](https://agents.md/) describes it as a “README for agents”: a predictable Markdown file for setup, tests, conventions, security considerations, and other repository guidance that complements human-facing documentation.

**Open-format rules and guidance:**

- Create `AGENTS.md` at repository root for repository-wide guidance.
- In large repositories, add nested `AGENTS.md` files for subprojects.
- The closest file in the directory tree takes precedence.
- Explicit user chat instructions override file instructions.
- There are no required fields or headings; it is standard Markdown.

These statements appear in [How to use AGENTS.md and its FAQ](https://agents.md/#how-to-use-agentsmd). Project overview, setup, build/test commands, style, testing, security, deployment, and PR guidance are examples, not a schema.

There is no standard YAML frontmatter, registration file, executable-resource directory, validation CLI, or activation metadata for `AGENTS.md`. Bolovan should preserve it as Markdown rather than invent mandatory fields that would break portability.

### Hierarchy and precedence are less uniform than the slogan

The canonical site says the closest file wins, but first-party clients reveal materially different mechanics:

- **OpenAI Codex:** reads a global `AGENTS.override.md` or `AGENTS.md`, then from project root down to the launch/current directory. It chooses at most one file per directory, concatenates root-to-leaf, lets later/closer guidance override earlier content, skips empty files, and caps the combined project instructions at 32 KiB by default. `AGENTS.override.md`, fallback filenames, global scope, the current-working-directory boundary, and the size limit are [Codex product behavior](https://developers.openai.com/codex/guides/agents-md/), not open-format requirements.
- **GitHub Copilot:** documents `AGENTS.md` files anywhere in a repository and says the nearest one takes precedence. It also warns that support outside the workspace root can be disabled by default in VS Code. See [GitHub's repository instruction guidance](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide#creating-custom-instructions).
- **VS Code:** root `AGENTS.md` support is automatic, while multiple nested files are experimental. When enabled, VS Code recursively adds nested file paths to context and lets the agent decide applicability, rather than promising deterministic host-side replacement. See [VS Code's AGENTS.md behavior](https://code.visualstudio.com/docs/agent-customization/custom-instructions#_use-an-agentsmd-file).
- **Gemini CLI:** defaults to `GEMINI.md`, not `AGENTS.md`; users can configure `context.fileName` to include `AGENTS.md`. Its hierarchy includes global, workspace/ancestor, and just-in-time files. Thus its AGENTS.md interoperability is opt-in configuration, not default conformance. See [Gemini context filename configuration](https://geminicli.com/docs/cli/gemini-md/#customize-the-context-file-name).

**Compatibility implication:** A portable root `AGENTS.md` has the widest and least ambiguous support. Nested files are useful, but authors should repeat or explicitly negate critical rules where clients' merge behavior could differ. Bolovan must document its scope root, search direction, merge/override algorithm, size limits, reload timing, and behavior on conflicting instructions.

### AGENTS.md security

`AGENTS.md` is instruction-bearing repository content. A cloned project can attempt prompt injection even though the format itself cannot execute code. Commands in the file are recommendations to the agent, not prior user authorization.

**Bolovan recommendation:** apply the same workspace-trust decision used for project skills; label source and scope in the prompt; never let `AGENTS.md` expand tools, bypass approvals, expose secrets, or override system/developer/user instructions. Commands described in the file remain subject to normal tool policy and user approvals.

## Responsibility comparison

| Concern | `AGENTS.md` | Agent Skills |
| --- | --- | --- |
| Primary purpose | Persistent project/subtree guidance | Reusable task capability or workflow |
| Required filename | `AGENTS.md` | `SKILL.md` inside each skill directory |
| Required schema | None; standard Markdown | YAML frontmatter with constrained `name` and `description`, then Markdown |
| Discovery | Root plus optional nested hierarchy; client details vary | Install/search locations are client policy; each discovered child directory must contain `SKILL.md` |
| Scope | Directory subtree / repository work | Named capability selected by task relevance or explicit invocation |
| Loading | Usually always-on for the applicable scope | Progressive: metadata, then instructions, then resources |
| Precedence | Closest file wins at the format site; merge mechanics differ by client | Collision behavior is client policy; project-over-user is reference guidance |
| Resources and scripts | No standard bundling convention | Optional `scripts/`, `references/`, `assets/` conventions |
| Validation | No fields to validate beyond readable Markdown and local policy | Canonical field/name constraints and `skills-ref` validator |
| Security boundary | Untrusted instructions may suggest actions | Untrusted instructions plus possible executable code, dependencies, and assets |

Where they overlap, use this dividing line:

- Put durable repository facts, architecture boundaries, commands, and subtree-specific contribution rules in `AGENTS.md`.
- Put an optional, named, task-focused procedure in a skill when it benefits from explicit activation, reuse, references, templates, or deterministic scripts.
- Do not duplicate the same policy in both. Skills inherit higher-priority system/user policy and applicable project guidance; they do not override it.
- Do not turn every `AGENTS.md` section into a skill. That would replace a deep, predictable project module with many shallow prompt fragments and increase activation uncertainty.

## Minimal recommended Bolovan adoption profile

1. **Keep the two features separate in code and UI.** Add one small instruction-discovery path for `AGENTS.md` and one skill catalog/activation path for Agent Skills. Do not concatenate everything through the current `BrainStore.instructions()` string.
2. **Support canonical names only for conformance:** exact `AGENTS.md` and exact `SKILL.md`. Diagnose `SKILLS.MD` as a likely typo; do not silently accept it as standard.
3. **Start with one explicit runtime scope:** the user's configured Brain root. Read `<Brain>/AGENTS.md` as always-on Brain guidance. Defer nested `AGENTS.md` until Bolovan has a file-target concept that makes subtree scope deterministic.
4. **Use `<Brain>/Skills/<name>/SKILL.md` as the portable skill location.** The Agent Skills format does not mandate its installation root, while Obsidian Sync excludes dot-prefixed files and folders from syncing. A visible `Skills/` folder therefore preserves both standards conformance and Bolovan's portable-Brain promise. Do not maintain a second `.agents/skills/` runtime root.
5. **Strictly parse canonical metadata, catalog only valid skills, and surface diagnostics.** Match `name` to directory, enforce lengths/characters/types, preserve unknown standard-compatible metadata, and treat `allowed-tools` as inert experimental data.
6. **Implement progressive disclosure:** include only name, description, and a safe internal identifier initially; expose a dedicated activation/read mechanism that returns instructions plus bounded resource names. Load resources only on request.
7. **Do not add script execution as part of initial support.** Instruction and reference files already provide useful compatibility. If execution is added later, give it a separate capability, trust, preview, and approval design.
8. **Define precedence conservatively:** explicit user request > applicable trusted `AGENTS.md` > activated skill instructions, with system/developer safety policy always above repository content. Reject any content that claims to change that order.
9. **Bound all input:** maximum discovered skills, directory depth, metadata/body bytes, per-resource bytes, and total catalog bytes. Report omissions and collisions rather than truncating silently.
10. **Prove compatibility with fixtures from the canonical spec and `skills-ref`.** Keep authoring validation strict, runtime failures isolated per skill, and show users which sources were loaded.

## Confirmed Bolovan adoption decisions

The design grill completed on 2026-08-06 with the following decisions:

1. `<Brain>/AGENTS.md` replaces `<Brain>/Instructions.md` as the sole portable, always-on instruction file. Preserve existing instruction content during the clean rename. Support the Brain-root file only; defer nested hierarchy.
2. Discover only immediate `<Brain>/Skills/<name>/SKILL.md` packages. There is no legacy flat-skill migration or compatibility loader because Bolovan is unreleased and has no existing skills.
3. Strictly validate canonical filename, frontmatter types, name constraints, description, and directory-name match. Exclude invalid, colliding, or oversized units whole and show grouped, non-repeating Obsidian diagnostics.
4. Catalog only valid `name` and `description` metadata. Load complete instructions on activation and bounded resources on demand through a dedicated skill-reading capability.
5. Trust the configured Brain as instruction-bearing content, while preserving every existing tool, approval, stale-state, secret, and network boundary. Optional `allowed-tools` metadata grants no authority.
6. Do not execute bundled scripts or install dependencies. Automatic resource resolution remains inside the selected skill directory.
7. Apply instruction precedence as built-in safety and capability policy, then the current explicit user request, Brain `AGENTS.md`, and activated skills.
8. Allow implicit model activation and explicit wikilink activation. `[[code-review]]` activates the matching skill before the first provider request; natural-language requests remain supported.
9. Present notes and skills in one labeled mention picker. A bare exact name selects the skill; a same-named note receives a path-qualified or extension-qualified wikilink.
10. Activate multiple explicit skills in message order, deduplicate repeats, and omit complete later skills with a warning if their combined bound is exceeded. Never truncate instruction units.
11. A missing, changed, invalid, colliding, or oversized explicit skill warns and is not activated. It never falls back to an unvalidated ordinary-note attachment.
