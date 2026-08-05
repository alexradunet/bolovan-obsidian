# Research: Canvas and Bases capabilities for Bolovan

Research date: 2026-08-05  
Target: Obsidian 1.13.4+, desktop, iOS, and Android

## Question and conclusion

How can Bolovan safely read, create, update, discover, and open Obsidian Canvas and Bases files, and how should it answer one-off prompts that resemble a Bases query?

Canvas and Bases are visible vault files, so Bolovan's existing `Vault`-backed tools are the correct seam. The smallest complete common path is to deepen those tools rather than add one tool per Canvas node operation or Bases method:

1. `vault_read` reads exact source and must support character pagination because Obsidian may serialize a Canvas as one long JSON line.
2. `vault_inspect` parses `.canvas` and `.base` files into bounded structured results.
3. `vault_search` can discover and text-search Markdown, Canvas, and Bases files; Markdown metadata filters remain Markdown-only.
4. `vault_change` validates the resulting Canvas JSON or Bases YAML before it presents an exact approval preview, then retains its existing stale-state check.
5. `workspace` opens any visible vault file, including `.canvas` and `.base`.
6. Model instructions encode the format-specific workflow and preservation rules.

Obsidian's public interface does **not** expose a standalone `app.bases.query(...)`-style function. The public Bases query result is delivered to registered custom views. Bolovan must not reimplement the Bases expression engine or claim that a background text scan evaluated arbitrary Bases formulas. For a prompt-scoped query, use `vault_search` when its explicit filters are sufficient and leave `.base` files unchanged. When exact Bases formula semantics or a reusable view is required, create or update a `.base` file with approval and open it so Obsidian evaluates it.

## Primary sources

- [JSON Canvas 1.0 specification](https://jsoncanvas.org/spec/1.0/)
- [Obsidian Canvas public declarations](https://github.com/obsidianmd/obsidian-api/blob/master/canvas.d.ts)
- [Obsidian public API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [Official Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md)
- [Official Bases functions](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Functions.md)
- [Official Bases views](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Views.md)
- [Official custom Bases view guide](https://docs.obsidian.md/plugins/guides/bases-view)
- [Official Vault guide](https://docs.obsidian.md/Plugins/Vault)
- [Official Workspace guide](https://docs.obsidian.md/Plugins/User%20interface/Workspace)

The JSON Canvas specification owns the interoperable file format. Obsidian's declarations own the public plugin interface. Obsidian Help owns current Bases syntax and behavior. Recommendations below are explicitly labeled as Bolovan decisions.

## Canvas model

### Top level and ordering

A JSON Canvas document is a JSON object with optional `nodes` and `edges` arrays. Missing arrays are equivalent to empty arrays for inspection and validation. Node order is semantically relevant: nodes are listed from lowest to highest z-index, so changing array order changes visual stacking. [JSON Canvas specification](https://jsoncanvas.org/spec/1.0/)

Obsidian's `CanvasData` declaration types both arrays and permits arbitrary additional keys for forward compatibility. Node and edge declarations also permit arbitrary additional keys. Bolovan must preserve unknown keys instead of normalizing a file to only the fields it currently understands. [Canvas declarations](https://github.com/obsidianmd/obsidian-api/blob/master/canvas.d.ts)

### Nodes

Every node has a unique string `id`, a supported `type`, integer `x`/`y` coordinates, integer `width`/`height`, and an optional string `color`. JSON Canvas 1.0 defines four node types: [JSON Canvas specification](https://jsoncanvas.org/spec/1.0/)

| Type | Required data | Optional data |
|---|---|---|
| `text` | `text`: Markdown-capable plain text | Generic fields |
| `file` | `file`: vault-relative path | `subpath`, beginning with `#` |
| `link` | `url`: external resource URL | Generic fields |
| `group` | Generic fields | `label`, vault-relative `background`, `backgroundStyle` |

`backgroundStyle` is `cover`, `ratio`, or `repeat`. Groups are visual rectangles; the format has no child-ID list. Membership is represented by node geometry inside the group's bounds. Moving or resizing a group without considering contained-node coordinates can change the visual grouping. [JSON Canvas specification](https://jsoncanvas.org/spec/1.0/)

Bolovan decision: create only the four standardized node types. Preserve unknown fields already present. Broken file links can be intentional and should not make the Canvas structurally invalid, but newly created file-node paths should be vault-relative and subpaths must begin with `#`.

### Edges

Each edge has a unique string `id`, required `fromNode` and `toNode` IDs, optional endpoint sides (`top`, `right`, `bottom`, `left`), optional endpoint shapes (`none`, `arrow`), optional `color`, and optional `label`. `fromEnd` defaults to `none`; `toEnd` defaults to `arrow`. An edge is only useful when both referenced node IDs exist. [JSON Canvas specification](https://jsoncanvas.org/spec/1.0/)

Bolovan decision: reject new or resulting Canvas content with duplicate node IDs, duplicate edge IDs, dangling edge references, invalid standardized node fields, sides, endpoints, or group background styles. Keep arbitrary extra keys.

### Colors

Colors are strings. JSON Canvas defines presets `"1"` through `"6"` and custom hexadecimal colors. The actual preset appearance is intentionally application-defined. [JSON Canvas specification](https://jsoncanvas.org/spec/1.0/)

Bolovan decision: preserve any existing string color and avoid hard-coding visual RGB meanings beyond the standard preset numbers.

### Public runtime interface

The public Obsidian package publishes Canvas data declarations but no general Canvas controller for model-facing node/edge mutations. The portable route is therefore `Vault.cachedRead`/`Vault.process` on the `.canvas` file and `Workspace.openLinkText` to open it. [Canvas declarations](https://github.com/obsidianmd/obsidian-api/blob/master/canvas.d.ts) [Vault guide](https://docs.obsidian.md/Plugins/Vault) [Workspace guide](https://docs.obsidian.md/Plugins/User%20interface/Workspace)

A text mutation must parse and validate the **resulting** JSON before approval. The commit must then compare the approved source content or SHA-256 and write nothing if it changed. This retains unknown data and prevents a stale node or edge edit from overwriting concurrent Canvas changes.

## Bases model

### File structure

A `.base` file is valid YAML. The documented top-level sections are `filters`, `formulas`, `properties`, `summaries`, and `views`. Bases may also be embedded, and a saved Base view can be embedded with `![[File.base]]` or `![[File.base#View]]`. [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md) [Bases views](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Views.md)

The public `BasesConfigFile` declaration represents the serialized format. View implementations may store additional view-specific keys. Bolovan must preserve unknown view configuration and should preserve unknown top-level keys for forward compatibility rather than rewriting only today's documented fields. [Public API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

### Filters

A filter is either an expression string or a recursively nested object containing one of `and`, `or`, or `not`, whose value is a list of filters. Global and view filters are combined with logical `AND`. A Base without a filter considers every file in the vault; there is no SQL/Dataview-style `FROM` source. [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md)

Filter expressions and formulas use the same expression syntax. It supports arithmetic, comparisons, boolean operators, typed functions, dates, durations, lists, links, files, and objects. `today()` returns the current date at midnight; `now()` returns the current moment. Date arithmetic accepts duration strings such as `"1 week"`. [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md) [Bases functions](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Functions.md)

Bolovan decision: validate the recursive YAML shape and string expression placement, but do not invent an expression parser. Obsidian remains the authority that evaluates formula syntax and plugin-added functions when the Base renders.

### Properties and context

Bases has three property sources: [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md) [Public API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

- Note properties: `note.status`, `note["property name"]`, or unprefixed shorthand such as `status`.
- File properties: `file.name`, `file.path`, `file.folder`, `file.ext`, `file.size`, `file.ctime`, `file.mtime`, `file.tags`, `file.links`, `file.backlinks`, `file.embeds`, and `file.properties`.
- Formula properties: `formula.name`, defined by strings in the top-level `formulas` map.

The `this` context changes with placement: it is the Base file when opened directly, the embedding file when embedded, and the active main-area file when shown in a sidebar. A correct instruction must account for that context before generating filters such as `file.hasLink(this.file)`. [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md)

Display names in `properties` affect presentation, not expression identifiers. Formula properties may reference other formulas unless that creates a circular reference. Formula output type is determined by evaluated values, not by the YAML string container. [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md)

### Summaries and views

Top-level `summaries` defines named aggregation formulas using the `values` list. A view's `summaries` map assigns a summary name to a property. Built-in summaries include numeric aggregations, earliest/latest dates, boolean counts, and empty/filled/unique counts. [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md)

Each view requires a `type` and `name`, and may add `filters`, `groupBy`, `order`, `summaries`, limits, sorting, and layout-specific configuration. Built-in layouts documented for the target generation include table, cards, and list; map is provided by a plugin. A Base can contain multiple views, and the first is the default. [Bases syntax](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Bases%20syntax.md) [Bases views](https://github.com/obsidianmd/obsidian-help/blob/master/en/Bases/Views.md)

Bolovan decision: validate portable core fields while retaining layout-specific keys it does not understand. Do not rename a property in a formula merely because its display name changed.

### Public plugin interface and query limitation

The public interface lets a plugin register a custom renderer with `Plugin.registerBasesView()`. A `BasesView` receives the latest `BasesQueryResult`, whose `data` and `groupedData` contain files after Obsidian has executed the query, filters, formulas, user sorting, grouping, and limits. The result is replaced whenever vault or Base configuration changes. [Custom Bases view guide](https://docs.obsidian.md/plugins/guides/bases-view) [Public API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

The same public declarations do not expose a supported constructor or application method that accepts an arbitrary `BasesConfigFile` and returns `BasesQueryResult`. `registerBasesView()` is a rendering extension point, not a background query function. Creating a hidden view, temporarily editing a user's Base, or automating a core command would introduce UI state, user-data races, and reliance on behavior outside this public interface.

Bolovan decision: do not create a custom Bases evaluator and do not temporarily mutate a `.base` file for a one-off prompt. Revisit this only if Obsidian adds a public standalone query interface.

## Prompt-scoped filtering

For a transient user question, Bolovan should translate criteria into `vault_search` parameters when they fit its explicit contract: text, folder, tag, exact property value, resolved link, task state, or modification-time bounds. Multiple searches and bounded reads can refine the result without persisting a Base. This is a Bolovan search, not execution of an arbitrary Bases formula.

Examples:

| User intent | Safe transient behavior |
|---|---|
| Notes tagged `project` modified this week | `vault_search` with tag and millisecond time bound |
| Open notes with `status: active` | `vault_search` with property/value |
| Files matching an existing Base's simple folder/tag condition | Read/inspect the Base, translate supported conditions, and identify the answer as a Bolovan search |
| Exact result of a formula using `today()`, list functions, custom functions, summaries, or `this` | Ask Obsidian to evaluate a saved/open Base; do not claim `vault_search` is equivalent |
| Reusable dashboard or view | Create/update `.base` with exact approval, then open it |

This preserves the user's Base and avoids a write/undo cycle for an ephemeral question.

## Required Bolovan workflow

### Canvas

1. Inspect the Canvas for bounded node/edge structure and read exact source pages until the relevant content is available.
2. Preserve IDs, unknown keys, and node array order unless the requested visual stacking changes.
3. Keep edges attached to existing node IDs and account for incident edges before deleting a node.
4. Treat groups as geometry, not a child list.
5. Produce the smallest exact source patch where practical; use full replacement only when the whole generated Canvas is the requested result.
6. Let format validation pass before showing the approval preview.
7. After approval, rely on the source hash/current-content check; then optionally open the Canvas when the user asks.

### Bases

1. Inspect and read the current YAML before editing.
2. Preserve unknown top-level and view-specific keys.
3. Keep filters as expression strings or recursive `and`/`or`/`not` lists; remember global and view filters combine with `AND`.
4. Use `note.`, `file.`, and `formula.` identifiers deliberately; display names do not change identifiers.
5. Determine what `this` means at the intended placement before using it.
6. Quote expressions as YAML strings when nested quotes or punctuation could change YAML parsing.
7. Prefer an exact source patch so comments and formatting survive.
8. Validate YAML and the documented structural schema before preview. Obsidian performs final expression evaluation when the Base opens.
9. Edit a Base only for persistent user-requested behavior; use `vault_search` for a supported one-off filter.

## Safety and verification requirements

| Operation | Approval | Stale check | Format check |
|---|---|---|---|
| Read/inspect/search | No | Not applicable | Parse structured inspection |
| Create Canvas/Base | Required | Destination still absent | Validate full proposed content |
| Patch/append/replace | Required | Source content/hash unchanged | Validate resulting full content |
| Copy/move to `.canvas`/`.base` | Required | Source unchanged; destination absent | Validate content for destination extension |
| Archive/trash | Required | Source unchanged | No rewrite; preserve recovery path |
| Prompt-scoped search | No mutation | Cancellable and capped | Report that it is a Bolovan search, not exact Bases evaluation |

Tests should cover malformed JSON/YAML, duplicate Canvas IDs, dangling edges, invalid node-specific fields, recursive Base filters, malformed formulas/properties/views containers, preservation of unknown keys through source patches, stale approvals, structured-file discovery, and the model instruction distinction between transient search and persistent Base edits.

## Recommended implementation order

1. Add format-aware inspection and result validation to the existing vault module.
2. Add character-offset reads and `.canvas`/`.base` discovery so minified or large structured files remain reachable.
3. Add concise built-in instructions containing the workflow and the Bases query limitation.
4. Update workspace wording to open any vault file.
5. Verify real `.canvas` and `.base` files in an isolated Obsidian 1.13.4 vault.

Do not add a Canvas controller seam, Bases evaluator, custom query language, dependency, or temporary hidden Base. The existing tool interface already supplies the approval, cancellation, and persistence behavior; format-aware validation and instruction are the missing leverage.
