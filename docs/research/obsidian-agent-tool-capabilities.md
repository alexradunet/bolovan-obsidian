# Research: Obsidian capabilities for Bolovan agent tools

Research date: 2026-08-05  
Target: Obsidian 1.13.4+, desktop, iOS, and Android
Implementation status: the recommended first tranche was completed on 2026-08-05; active-selection editing remains deferred. See [ADR 0001](../adr/0001-native-cross-platform-harness.md).

## Question and method

Which public Obsidian capabilities would materially increase Bolovan's usefulness as an agent without weakening approval boundaries, mobile support, or the project's comprehension budget?

This review compares Bolovan's current model-facing tools with Obsidian's official developer documentation and public TypeScript declarations. API facts and repository observations are separated from recommendations. Absence claims mean “not exposed by the reviewed public declarations”; they do not claim that Obsidian has no internal implementation.

Reviewed primary sources:

- [Obsidian public API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [Obsidian Canvas declarations](https://github.com/obsidianmd/obsidian-api/blob/master/canvas.d.ts)
- [Official Vault guide](https://docs.obsidian.md/Plugins/Vault)
- [Official Workspace guide](https://docs.obsidian.md/Plugins/User%20interface/Workspace)
- [Official Commands guide](https://docs.obsidian.md/Plugins/User%20interface/Commands)
- [Official plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin%20guidelines)
- [Official Events guide](https://docs.obsidian.md/Plugins/Events)
- Bolovan's local [vault tools](../../src/vault-tools.ts), [agent loop](../../src/bolovan-agent.ts), [native-harness ADR](../adr/0001-native-cross-platform-harness.md), and [manifest](../../manifest.json)

## Executive conclusion

Bolovan should not mirror the Obsidian API with dozens of shallow model tools. Tool count is not the main limitation: `vault_change` can already rewrite any visible text file. The missing leverage is structured understanding, small deterministic edits, active-editor awareness, and native file lifecycle operations.

The best next tranche is:

1. Deepen `vault_read`, `vault_search`, `vault_list`, and `vault_change` with bounded reads, structured filters, deterministic text patches, copy, and Obsidian trash.
2. Add one read-only `vault_inspect` tool for native metadata, links, backlinks, headings, tags, properties, and tasks.
3. Add one small `workspace` tool for active-note/selection context and reversible note navigation.
4. Add approval-gated active-selection editing only after its stale-buffer and mobile behavior are proven.

This raises the stable model-facing set from five tools to seven, while adding far more capability than a method-per-tool design. Attachments, PDF extraction, frontmatter operations, and path-bounded CSS/theme work are valuable later candidates. Arbitrary command execution, core-plugin internals, secrets, unrestricted configuration/filesystem access, and background automation should remain unavailable.

## Pre-implementation Bolovan coverage

Before this implementation, Bolovan exposed five tools:

| Tool | Current behavior | Important gap |
| --- | --- | --- |
| `vault_read` | Reads one visible text file; also reads Bolovan's own hidden plugin subtree. Returns a SHA-256 for stale-write protection. | No line/heading/block bounds, parsed metadata, binary handling, or output cap. |
| `vault_search` | Case-insensitive substring scan of Markdown paths and contents; capped results. | No folder, tag, property, link, date, or task filters; the tool loop cannot stop the scan mid-call. |
| `vault_list` | Lists immediate children of one folder; also lists Bolovan's own hidden plugin subtree. | No recursive bounded listing or file stats. |
| `vault_change` | Creates, replaces, appends, moves, or archives files after exact preview and approval; existing-file commits recheck SHA-256/current content. | No deterministic partial edit, copy, Obsidian trash, explicit folder operation, attachment, or active-editor-aware edit. |
| `web_read` | Reads bounded text from a user-supplied HTTP(S) URL and treats it as untrusted content. | Deliberately not arbitrary network access, binary import, or web search. |

`VaultTools` is one policy-owning module, and `BolovanAgent.executeTool()` is the single approval gate. That locality is worth preserving. [Local implementation](../../src/vault-tools.ts) and [tool loop](../../src/bolovan-agent.ts)

ADR 0001 says the Vault adapter exposes “exactly” four vault tools. Adding or renaming stable tools therefore requires updating that accepted decision, not silently drifting from it. [ADR 0001](../adr/0001-native-cross-platform-harness.md)

## Public Obsidian capability map

### Vault files and folders

Public `Vault` methods cover text and binary creation/reading/modification, folder creation, atomic text processing, copying, listing, renaming, deletion, and trash. Relevant members include `create`, `createBinary`, `createFolder`, `cachedRead`, `read`, `readBinary`, `process`, `copy`, `getFiles`, `getMarkdownFiles`, `getAllFolders`, `delete`, and `trash`. `TFile.stat` exposes creation time, modification time, and byte size. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

The official Vault guide recommends `cachedRead()` for display, `read()` for read-modify-write, and `Vault.process()` for atomic modifications. It distinguishes permanent `delete()` from recoverable `trash()`. [Vault guide](https://docs.obsidian.md/Plugins/Vault)

`FileManager.renameFile()` updates links according to the user's Obsidian preferences. `FileManager.trashFile()` follows the user's preferred trash behavior. These are better product semantics than raw adapter rename/delete calls. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) and [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin%20guidelines)

**Tool opportunity:** deepen existing read/list/change tools. Do not create one tool for each Vault method.

### Metadata, links, properties, headings, and tasks

`MetadataCache.getFileCache()` returns `CachedMetadata`. Public cache fields include links, embeds, tags, headings, sections, list items, frontmatter, frontmatter links, footnotes, and blocks. Each parsed item carries source positions. `ListItemCache.task` identifies task status. `MetadataCache.resolvedLinks` and `unresolvedLinks` expose vault-wide link relationships, while `getFirstLinkpathDest()` resolves a wikilink from a source note. Helpers include `getAllTags()`, `parseLinktext()`, and `resolveSubpath()`. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

The cache can be absent while a file is not yet indexed. A tool must report that state; it must not invent metadata or build a second persistent index. Link/backlink outputs must be capped because the public maps can be vault-wide.

**Tool opportunity:** one `vault_inspect` tool plus structured filters on `vault_search`.

### Frontmatter and Properties

`FileManager.processFrontMatter()` atomically mutates Markdown frontmatter and handles Obsidian's YAML layout. The official guidelines explicitly prefer it over manual YAML parsing. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) and [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin%20guidelines)

For Bolovan, atomicity is necessary but not sufficient. Model-initiated changes still require an exact preview and a stale-state check between approval and commit. A naive wrapper around `processFrontMatter()` cannot promise the exact resulting bytes before Obsidian serializes them.

**Tool opportunity:** valuable, but later. Implement only after the preview can show the exact resulting file or an equally exact, narrowly defined property operation whose serializer effects are fully known.

### Active workspace and editor

`Workspace.activeEditor` exposes the active `MarkdownFileInfo`; it can provide the current file and `Editor`. `Editor` exposes the in-memory value, selection, cursor/ranges, transactions, `replaceSelection()`, and `replaceRange()`. `Workspace.getActiveFile()`, `getLeaf()`, `openLinkText()`, `WorkspaceLeaf.openFile()`, and `revealLeaf()` support navigation. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts) and [Workspace guide](https://docs.obsidian.md/Plugins/User%20interface/Workspace)

The official guidelines recommend the Editor interface instead of `Vault.modify()` for the active note because Editor preserves cursor, selection, folds, and the editing experience. They recommend `Vault.process()` for background-file edits. [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin%20guidelines)

Pop-out windows are explicitly desktop-only. A cross-platform agent tool must exclude the `'window'` pane mode. Opening a normal tab or split is reversible UI state and does not mutate user-authored content, but it should still be invoked only when the user's request calls for navigation.

**Tool opportunity:** a small `workspace` tool now; approval-gated selection editing after a dedicated stale-buffer design and desktop/mobile smoke test.

### Attachments and binary resources

`FileManager.getAvailablePathForAttachment()` applies the user's attachment-folder preference and deduplicates names. `Vault.createBinary()` and `readBinary()` handle bytes. `Vault.getResourcePath()` produces an embeddable resource URI. `FileManager.generateMarkdownLink()` creates a link using the user's link preferences. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

**Tool opportunity:** later `vault_import_attachment` can fetch a bounded user-supplied URL, preview the asset hash/size/type and exact note edit, then atomically create the asset and insert the generated link. This is a multi-resource transaction and needs rollback/recovery behavior; it should not be a generic base64 write tool.

### PDF and rich file reading

The public package exposes `loadPdfJs()`, and `Vault.readBinary()` can supply PDF bytes. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

**Tool opportunity:** a bounded read-only `vault_extract` tool could extract PDF text without a new dependency. Mobile performance and loader availability must be exercised on iOS and Android before this becomes a support promise. Image understanding is not supplied by the Vault API; it would require a model/media-input design.

### Canvas and Bases

The official `canvas.d.ts` defines the JSON Canvas data model: file, text, link, and group nodes plus edges. [Canvas declarations](https://github.com/obsidianmd/obsidian-api/blob/master/canvas.d.ts)

The main declarations expose `.base` configuration types and the `registerBasesView()` extension point. They do not expose a general `app.bases.query(...)` model-facing query interface. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

Current `vault_read`/`vault_change` can already read and write these plaintext formats even though their descriptions imply Markdown/text notes. Specialized Canvas or Bases tools should wait for demonstrated invalid-output problems. First clarify generic tool descriptions and validate extension-specific content before commit.

### Commands, core plugins, and UI primitives

The public command surface documented for plugins is `Plugin.addCommand()`—registering Bolovan's own commands. The reviewed `App` declaration does not expose a public command manager for listing or executing arbitrary core/third-party commands. [Commands guide](https://docs.obsidian.md/Plugins/User%20interface/Commands) and [public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

Likewise, the reviewed declarations do not expose public runtime managers for Bookmarks, Daily Notes, Templates, Graph, or the core Search view. Access patterns commonly using `app.commands`, `app.internalPlugins`, or private view objects are undocumented internals.

Public `Notice`, `Modal`, `Menu`, views, settings, commands, and events are useful for Bolovan's own interface and lifecycle, but they are not inherently valuable model tools. Event handlers must be registered for cleanup. [Events guide](https://docs.obsidian.md/Plugins/Events) and [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin%20guidelines)

**Decision:** do not expose arbitrary command execution or core-plugin internals. Add direct, typed capabilities for proven user outcomes instead.

### Hidden configuration and customization

`Vault.configDir` gives the actual hidden configuration folder name. `DataAdapter` provides text/binary read, write, process, list, mkdir, rename, copy, and trash operations, while its own declaration says to prefer `Vault` when possible. [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

Bolovan's project policy permits path-bounded capabilities for its own directory and approved Obsidian customization such as themes, CSS snippets, and specifically named settings. It forbids unrestricted adapter access, other plugins' configuration, secrets, and unrelated hidden files. [Engineering rules](../../AGENTS.md)

**Tool opportunity:** later, opt-in `obsidian_style` actions for a named CSS snippet or complete theme package. Each action needs an exact preview, config-file hash recheck, strict path construction under `Vault.configDir`, and a recovery copy. Do not expose arbitrary config paths or an untyped “set Obsidian setting” action.

### Secrets, local storage, and network

`App.secretStorage` can read, list, and write vault-local secrets. `App.loadLocalStorage()` and `saveLocalStorage()` expose vault-specific local data. `requestUrl()` provides cross-origin HTTP(S). [Public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

These public methods are not automatically appropriate agent powers. Model access to secret values or secret IDs would violate Bolovan's security boundary. Model-directed plugin settings/local storage would mix deterministic plugin ownership with untrusted output. An arbitrary network-request tool would exceed the current user-supplied, read-only `web_read` contract.

**Decision:** keep secrets and device-local plugin state entirely outside model tools; retain the narrow GET-only web capability.

## Recommended interfaces

These are model-facing interfaces, not one-to-one Obsidian wrappers.

### 1. Deepen `vault_read`

Add optional, mutually exclusive bounds:

```text
vault_read(path, subpath?, start_line?, end_line?)
```

- `subpath` accepts an Obsidian heading/block subpath and uses `MetadataCache`/`resolveSubpath()`.
- Line bounds allow surgical context reads.
- Always return the whole-file SHA-256, selected range/subpath, truncation state, and bounded content.
- Preserve the existing path policy; do not broaden hidden-file reads.

**Value:** high. **Complexity:** low. **Approval:** none.

### 2. Deepen `vault_search`

Keep substring search as the common path, then add a small set of optional filters:

```text
vault_search(query?, folder?, tag?, property?, linked_to?, task_status?, limit?)
```

- Avoid implementing Obsidian's private Search query language.
- Use `MetadataCache` for tags, properties, links, and tasks; scan file text only when `query` is present.
- Return matched reasons and source positions, not only path names.
- Cap results and matches per file. Pass the run's `AbortSignal` into the tool so Stop can end long scans.

**Value:** very high. **Complexity:** medium. **Approval:** none.

### 3. Deepen `vault_list`

```text
vault_list(path, recursive?, limit?, include_stats?)
```

- Default remains one level.
- Recursive output is capped and reports truncation.
- Stats use `TFile.stat`; folders remain typed as folders.

**Value:** medium. **Complexity:** low. **Approval:** none.

### 4. Deepen `vault_change`

Add only operations that share the existing exact-preview/stale-commit policy:

```text
vault_change(action: patch | copy | trash | existing actions, ...)
```

- `patch`: require `expected_hash`, exact `before` text, replacement text, and exactly one match. Preview the resulting content; commit through `Vault.process()` only if both the whole hash/current content and matched text remain unchanged.
- `copy`: require source hash and an absent destination; use `Vault.copy()`.
- `trash`: file-only in the first cut; require source hash; use `FileManager.trashFile()` so user preferences determine system/local trash. Do not add permanent delete.
- Explicit folder move/trash can follow only with a bounded descendant fingerprint and clear recovery semantics.

**Value:** very high. **Complexity:** medium. **Approval:** exact preview plus stale-state recheck.

### 5. Add `vault_inspect`

```text
vault_inspect(path)
```

Return one bounded object containing:

- path, extension, size, creation/modification times;
- frontmatter/properties;
- headings and blocks;
- tags;
- outgoing links and embeds with resolved destinations;
- backlinks and unresolved links;
- task lines and statuses.

Omit empty sections and cap every array. Report `metadata_pending` when no cache exists rather than falling back to invented parsing.

**Value:** very high. **Complexity:** low-to-medium. **Approval:** none.

### 6. Add `workspace`

```text
workspace(action: context | open, path?, subpath?, pane?)
```

- `context`: return active file, selected text, selection/cursor ranges, and an SHA-256 of the in-memory editor buffer. Do not return the whole buffer unless explicitly requested and bounded.
- `open`: resolve through public link/file APIs and use only current/tab/split pane modes; never desktop-only pop-outs.
- Never replace Bolovan's own chat leaf. Reuse an existing target leaf or a Markdown/root leaf; otherwise create a normal tab.
- Opening is reversible UI state, not a content mutation. It does not need the content-approval modal, but the system prompt should limit it to user-requested navigation.

**Value:** high. **Complexity:** medium. **Approval:** none for read/open.

### 7. Later: `editor_change`

Start with one operation only:

```text
editor_change(action: replace_selection, expected_buffer_hash, expected_ranges, content)
```

- Prepare an exact before/after selection preview.
- At commit, re-read the in-memory buffer and ranges; any change rejects the approval.
- Apply one Editor transaction so Obsidian undo and cursor behavior remain intact.
- Never silently fall back to a Vault write if the active editor changed.

**Value:** high. **Complexity/risk:** high. **Approval:** required.

## Candidate ranking

| Rank | Capability | User value | Complexity/risk | Decision |
| ---: | --- | --- | --- | --- |
| 1 | Bounded read + deterministic patch | Very high | Low–medium | Implement first by deepening existing tools. |
| 2 | Metadata/link/task inspection | Very high | Low–medium | Add `vault_inspect`. |
| 3 | Structured search filters | Very high | Medium | Deepen `vault_search`; remain scan-first and cancellable. |
| 4 | Native copy and trash | High | Medium | Add to `vault_change`; no permanent delete. |
| 5 | Active context and note navigation | High | Medium | Add `workspace`; exclude pop-outs. |
| 6 | Active selection editing | High | High | Implement after stale-buffer/mobile proof. |
| 7 | Frontmatter/property operation | High | High | Later; exact serializer preview is the gating issue. |
| 8 | Attachment import and link insertion | Medium–high | High | Later; bounded two-resource transaction. |
| 9 | PDF text extraction | Medium | Medium | Conditional on desktop/iOS/Android runtime proof. |
| 10 | CSS snippet/theme capability | Medium | High policy risk | Later, opt-in and strictly path-bounded. |
| 11 | Dedicated Canvas/Bases tools | Low today | Medium | Do not add until generic file operations demonstrably fail users. |
| 12 | Arbitrary commands/core-plugin access | Potentially high | Unstable, undocumented | Reject. |
| 13 | Secret/local-storage tool | Negative | Critical security risk | Reject. |
| 14 | Shell/raw filesystem/arbitrary HTTP/background agents | Outside product contract | Critical portability/safety risk | Reject. |

## Approval and stale-state policy

| Operation class | Approval | Commit check | Recovery |
| --- | --- | --- | --- |
| Metadata/read/search/list/context | No | Respect current run cancellation and result caps. | Not applicable. |
| Workspace open/reveal | No content approval | Resolve target immediately before opening. | User can close/navigate back. |
| File patch/replace/append | Required | Whole source hash/current content; patch also rechecks exact matched text. | New approved reverse edit; retain exact before state in transcript. |
| Create/copy | Required | Destination still absent; source hash for copy. | Approved trash/archive of created item. |
| Move | Required | Source hash and destination absence. | Approved reverse move. |
| Trash | Required | Source hash; file still exists. | Obsidian/system trash where available. Never permanent delete. |
| Active editor change | Required | In-memory buffer hash, file identity, and ranges unchanged. | Single Editor transaction supports Undo. |
| Attachment import | Required | Downloaded byte hash/size/type, destination absence, target-note hash. | Trash asset plus reverse note edit. |
| Hidden customization | Required | Strict capability/path check plus current config hash. | Deterministic backup/revert path. |

All mutating tools must return a Prepared change and pass through the existing single approval gate. Tool implementations must never display a preview and then use a different serializer or path at commit.

## Incremental implementation order

1. Update ADR 0001 to authorize a small, extensible Obsidian-tool set while preserving the two-phase mutation contract.
2. In `src/vault-tools.ts`, add bounded reads, `patch`, structured/cancellable search, `vault_inspect`, `copy`, and file trash. Keep this as one vertical module with interface-level tests.
3. Add a focused workspace module for `context` and `open`; wire only its small definition and dispatch into `BolovanAgent`.
4. Smoke-test the new read/search/workspace paths in disposable desktop, iOS, and Android vaults. In particular, verify chat-view focus, tabs/splits, large-vault cancellation, metadata-not-ready behavior, and trash preferences.
5. Add `editor_change` only after an exact selection preview and stale-buffer rejection work end to end on all three platforms.
6. Consider frontmatter, attachment, PDF, and customization tools one vertical behavior at a time. Do not pre-create abstractions for the later candidates.

## Final recommendation

Implement the first tranche as **two new tools plus deeper existing tools**, not as an Obsidian API mirror:

- New: `vault_inspect`, `workspace`.
- Deepen: `vault_read`, `vault_search`, `vault_list`, `vault_change`.
- Defer: `editor_change`, frontmatter, attachments, PDF extraction, CSS/themes.
- Reject: arbitrary commands, core-plugin internals, secrets, unrestricted adapter/filesystem/network access, and background automation.

This is the smallest change that gives the model substantially better understanding and safer control of Obsidian while keeping the system traceable through the existing agent loop and one or two policy-owning modules.
