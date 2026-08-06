import {
  getAllTags,
  normalizePath,
  resolveSubpath,
  TFile,
  TFolder,
  type App,
  type CachedMetadata,
} from "obsidian";
import type { ToolDefinition } from "./model-adapter";
import type { ModelTool, PreparedChange, ToolResult } from "./model-tools";
import { inspectStructuredFile, validateStructuredFile } from "./structured-files";

const MAX_READ_CHARS = 40_000;
const MAX_INSPECT_ITEMS = 100;


const VAULT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "vault_read",
    description: "Read bounded exact source from a Markdown, Canvas, Bases, or other text file. Select line numbers, a character offset, or a Markdown subpath.",
    parameters: objectSchema({
      path: { type: "string", description: "Vault-relative file path" },
      subpath: { type: "string", description: "Optional Markdown subpath beginning with #, such as #Heading or #^block-id" },
      start_line: { type: "integer", minimum: 1, description: "Optional 1-based first line" },
      end_line: { type: "integer", minimum: 1, description: "Optional 1-based inclusive last line" },
      start_char: { type: "integer", minimum: 0, description: "Optional 0-based character offset for paginating long or single-line files" },
    }, ["path"]),
  },
  {
    name: "vault_search",
    description: "Search Markdown, Canvas, or Bases paths and contents. Obsidian metadata filters apply only to Markdown. Filters are combined and results are capped.",
    parameters: objectSchema({
      query: { type: "string", description: "Case-insensitive path/content substring" },
      extension: { type: "string", enum: ["md", "canvas", "base"], description: "File extension to search; defaults to md" },
      folder: { type: "string", description: "Limit results to this vault folder" },
      tag: { type: "string", description: "Require this Obsidian tag" },
      property: { type: "string", description: "Require this frontmatter property" },
      property_value: { type: "string", description: "Require an exact textual property value" },
      linked_to: { type: "string", description: "Require a resolved link to this vault path" },
      task_status: { type: "string", enum: ["any", "incomplete", "complete"] },
      modified_after: { type: "integer", minimum: 0, description: "Require mtime after this Unix timestamp in milliseconds" },
      modified_before: { type: "integer", minimum: 0, description: "Require mtime before this Unix timestamp in milliseconds" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
  },
  {
    name: "vault_list",
    description: "List files and folders inside a vault folder, optionally recursively with file statistics. Results are capped.",
    parameters: objectSchema({
      path: { type: "string", description: "Folder path; empty means vault root" },
      recursive: { type: "boolean", description: "Include descendants; defaults to false" },
      include_stats: { type: "boolean", description: "Include file size and timestamps; defaults to false" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }),
  },
  {
    name: "vault_inspect",
    description: "Inspect one vault file. Returns native Markdown metadata or validated, bounded Canvas/Bases structure.",
    parameters: objectSchema({ path: { type: "string", description: "Vault-relative Markdown, Canvas, or Bases file path" } }, ["path"]),
  },
  {
    name: "vault_change",
    description: "Create, replace, patch, append, copy, move, archive, or trash a vault file. Canvas JSON and Bases YAML are validated before every exact approval preview.",
    parameters: objectSchema({
      action: { type: "string", enum: ["create", "replace", "patch", "append", "copy", "move", "archive", "trash"] },
      path: { type: "string", description: "Current or new vault-relative file path" },
      content: { type: "string", description: "Content for create/replace/append, or replacement text for patch" },
      before: { type: "string", description: "Exact, uniquely occurring source text required for patch" },
      destination: { type: "string", description: "Destination path for copy or move" },
      expected_hash: { type: "string", description: "Whole-file SHA-256 from vault_read or vault_inspect; required when changing an existing file" },
    }, ["action", "path"]),
  },
];
export function createVaultModelTools(app: App): ModelTool[] {
  const vault = new VaultTools(app);
  return VAULT_TOOL_DEFINITIONS.map((definition) => ({
    definition,
    execute: (args, signal) => vault.execute(definition.name, args, signal),
  }));
}


export class VaultTools {
  constructor(private readonly app: App) {}

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult | PreparedChange> {
    throwIfAborted(signal);
    if (name === "vault_read") {
      return this.read(args, signal);
    }
    if (name === "vault_search") {
      return this.search(args, signal);
    }
    if (name === "vault_list") {
      return this.list(args, signal);
    }
    if (name === "vault_inspect") {
      return this.inspect(rawPath(args.path), signal);
    }
    if (name === "vault_change") {
      return this.prepareChange(args);
    }
    throw new Error(`Unknown Vault tool: ${name}`);
  }

  private async read(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const path = safePath(rawPath(args.path));
    const subpath = optionalArgumentString(args, "subpath");
    const startLine = optionalInteger(args, "start_line", 1);
    const endLine = optionalInteger(args, "end_line", 1);
    const startChar = optionalInteger(args, "start_char", 0);
    if (subpath && (startLine !== undefined || endLine !== undefined || startChar !== undefined)) {
      throw new Error("vault_read accepts one selector: subpath, line bounds, or start_char");
    }
    if (startChar !== undefined && (startLine !== undefined || endLine !== undefined)) {
      throw new Error("vault_read accepts either line bounds or start_char, not both");
    }
    if (endLine !== undefined && startLine !== undefined && endLine < startLine) {
      throw new Error("end_line must be greater than or equal to start_line");
    }

    let file: TFile | null = null;
    let content: string;
    if (this.isConfigPath(path)) {
      this.assertReadableConfigPath(path);
      if (subpath) {
        throw new Error("Subpath reads are available only for visible Markdown files");
      }
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) {
        return { content: `File not found: ${path}`, isError: true };
      }
      throwIfAborted(signal);
      content = await adapter.read(path);
    } else {
      file = this.app.vault.getFileByPath(path);
      if (!file) {
        return { content: `File not found: ${path}`, isError: true };
      }
      content = await this.app.vault.cachedRead(file);
    }
    throwIfAborted(signal);

    const selection = this.selectReadContent(content, file, subpath, startLine, endLine, startChar);
    const truncated = selection.content.length > MAX_READ_CHARS;
    return {
      content: JSON.stringify({
        path,
        hash: await sha256(content),
        ...selection.details,
        content: selection.content.slice(0, MAX_READ_CHARS),
        totalChars: selection.content.length,
        truncated,
      }),
    };
  }

  private selectReadContent(
    content: string,
    file: TFile | null,
    subpath: string,
    startLine: number | undefined,
    endLine: number | undefined,
    startChar: number | undefined,
  ): { content: string; details: Record<string, unknown> } {
    if (subpath) {
      if (!subpath.startsWith("#")) {
        throw new Error("subpath must begin with #");
      }
      const cache = file ? this.app.metadataCache.getFileCache(file) : null;
      if (!cache) {
        throw new Error(`Metadata is not ready for ${file?.path ?? "this file"}; try again shortly`);
      }
      const resolved = resolveSubpath(cache, subpath);
      if (!resolved) {
        throw new Error(`Subpath not found: ${subpath}`);
      }
      const endOffset = resolved.end?.offset ?? content.length;
      return {
        content: content.slice(resolved.start.offset, endOffset),
        details: {
          subpath,
          range: {
            startLine: resolved.start.line + 1,
            endLine: resolved.end?.line ?? content.split("\n").length,
          },
        },
      };
    }
    if (startChar !== undefined) {
      if (startChar > content.length) {
        throw new Error(`start_char ${startChar} is past the end of the file (${content.length} characters)`);
      }
      const remaining = content.slice(startChar);
      const endChar = startChar + Math.min(remaining.length, MAX_READ_CHARS);
      return {
        content: remaining,
        details: {
          range: { startChar, endChar },
          sourceChars: content.length,
          nextStartChar: endChar < content.length ? endChar : undefined,
        },
      };
    }


    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split("\n");
      const first = startLine ?? 1;
      if (first > lines.length) {
        throw new Error(`start_line ${first} is past the end of the file (${lines.length} lines)`);
      }
      const last = Math.min(endLine ?? lines.length, lines.length);
      return {
        content: lines.slice(first - 1, last).join("\n"),
        details: { range: { startLine: first, endLine: last } },
      };
    }

    return { content, details: {} };
  }

  private async search(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const query = optionalArgumentString(args, "query").trim();
    const extensionArg = optionalArgumentString(args, "extension").trim().toLocaleLowerCase();
    const extension = extensionArg || "md";
    const folderArg = optionalArgumentString(args, "folder").trim();
    const folder = folderArg ? safePath(folderArg) : "";
    const tagArg = optionalArgumentString(args, "tag").trim();
    const tag = tagArg ? (tagArg.startsWith("#") ? tagArg : `#${tagArg}`) : "";
    const property = optionalArgumentString(args, "property").trim();
    const propertyValue = optionalArgumentString(args, "property_value", true);
    const linkedToArg = optionalArgumentString(args, "linked_to").trim();
    const linkedTo = linkedToArg ? safePath(linkedToArg) : "";
    const taskStatus = optionalArgumentString(args, "task_status").trim();
    const modifiedAfter = optionalInteger(args, "modified_after", 0);
    const modifiedBefore = optionalInteger(args, "modified_before", 0);
    const limit = boundedInteger(args.limit, 20, 1, 50, "limit");

    if (!["md", "canvas", "base"].includes(extension)) {
      throw new Error(`Unsupported search extension: ${extension}`);
    }

    if (propertyValue && !property) {
      throw new Error("property_value requires property");
    }
    if (taskStatus && !["any", "incomplete", "complete"].includes(taskStatus)) {
      throw new Error(`Unsupported task_status: ${taskStatus}`);
    }
    const needsMetadata = Boolean(tag || property || linkedTo || taskStatus);
    if (needsMetadata && extension !== "md") {
      throw new Error("Tag, property, link, and task filters are available only when extension is md");
    }
    if (!query && !extensionArg && !folder && !tag && !property && !linkedTo && !taskStatus
      && modifiedAfter === undefined && modifiedBefore === undefined) {
      throw new Error("vault_search requires at least one search term or filter");
    }

    const wanted = query.toLocaleLowerCase();
    const files = extension === "md"
      ? this.app.vault.getMarkdownFiles()
      : this.app.vault.getFiles().filter((file) => file.extension.toLocaleLowerCase() === extension);
    const results: Array<{ path: string; matches: string[]; reasons: string[] }> = [];
    let metadataPending = 0;

    for (const file of files) {
      throwIfAborted(signal);
      if (results.length >= limit) {
        break;
      }
      if (folder && !file.path.startsWith(`${folder}/`)) {
        continue;
      }
      if (modifiedAfter !== undefined && (file.stat?.mtime ?? -1) <= modifiedAfter) {
        continue;
      }
      if (modifiedBefore !== undefined && (file.stat?.mtime ?? Number.POSITIVE_INFINITY) >= modifiedBefore) {
        continue;
      }

      const cache = needsMetadata ? this.app.metadataCache.getFileCache(file) : null;
      if (needsMetadata && !cache) {
        metadataPending += 1;
        continue;
      }
      const reasons: string[] = [];
      if (tag) {
        const tags = getAllTags(cache as CachedMetadata) ?? [];
        if (!tags.some((candidate) => candidate.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
          continue;
        }
        reasons.push(`tag:${tag}`);
      }
      if (property) {
        const match = matchingProperty(cache?.frontmatter, property);
        if (!match || (propertyValue && !propertyValueMatches(match.value, propertyValue))) {
          continue;
        }
        reasons.push(propertyValue ? `property:${match.key}=${propertyValue}` : `property:${match.key}`);
      }
      if (linkedTo) {
        if ((this.app.metadataCache.resolvedLinks[file.path]?.[linkedTo] ?? 0) < 1) {
          continue;
        }
        reasons.push(`linked_to:${linkedTo}`);
      }
      if (taskStatus) {
        const tasks = (cache?.listItems ?? []).filter((item) => item.task !== undefined);
        const hasTask = taskStatus === "any"
          ? tasks.length > 0
          : taskStatus === "incomplete"
            ? tasks.some((item) => item.task === " ")
            : tasks.some((item) => item.task !== " ");
        if (!hasTask) {
          continue;
        }
        reasons.push(`task_status:${taskStatus}`);
      }

      const matches: string[] = [];
      if (query) {
        if (file.path.toLocaleLowerCase().includes(wanted)) {
          reasons.push("path");
        }
        const content = await this.app.vault.cachedRead(file);
        throwIfAborted(signal);
        for (const [index, line] of content.split("\n").entries()) {
          const found = line.toLocaleLowerCase().indexOf(wanted);
          if (found >= 0) {
            const start = Math.max(0, found - 100);
            const prefix = start > 0 ? "…" : "";
            matches.push(`${index + 1}: ${prefix}${line.slice(start, start + 300)}`);
            if (matches.length >= 3) {
              break;
            }
          }
        }
        if (matches.length) {
          reasons.push("content");
        }
        if (!reasons.includes("path") && !matches.length) {
          continue;
        }
      }
      results.push({ path: file.path, matches, reasons });
    }

    return {
      content: JSON.stringify({
        query: query || undefined,
        filters: {
          extension,
          folder: folder || undefined,
          tag: tag || undefined,
          property: property || undefined,
          propertyValue: propertyValue || undefined,
          linkedTo: linkedTo || undefined,
          taskStatus: taskStatus || undefined,
          modifiedAfter,
          modifiedBefore,
        },
        results,
        cappedAt: limit,
        metadataPending,
      }),
    };
  }

  private async list(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const raw = optionalArgumentString(args, "path", true);
    const path = raw ? safePath(raw) : "";
    const recursive = optionalBoolean(args, "recursive") ?? false;
    const includeStats = optionalBoolean(args, "include_stats") ?? false;
    const limit = boundedInteger(args.limit, 100, 1, 200, "limit");

    if (this.isConfigPath(path)) {
      return this.listConfig(path, recursive, includeStats, limit, signal);
    }
    const folder = path ? this.app.vault.getFolderByPath(path) : this.app.vault.getRoot();
    if (!folder) {
      return { content: `Folder not found: ${path}`, isError: true };
    }

    const queue = [...folder.children].sort(comparePaths);
    const entries: Array<Record<string, unknown>> = [];
    for (let index = 0; index < queue.length && entries.length <= limit; index += 1) {
      throwIfAborted(signal);
      const child = queue[index];
      if (!child) {
        continue;
      }
      if (!(child instanceof TFile) && !(child instanceof TFolder)) {
        continue;
      }
      entries.push(vaultEntry(child, includeStats));
      if (recursive && child instanceof TFolder) {
        queue.push(...[...child.children].sort(comparePaths));
      }
    }
    const truncated = entries.length > limit;
    return {
      content: JSON.stringify({ path, entries: entries.slice(0, limit), cappedAt: limit, truncated }),
    };
  }

  private async listConfig(
    path: string,
    recursive: boolean,
    includeStats: boolean,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    this.assertReadableConfigPath(path);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) {
      return { content: `Folder not found: ${path}`, isError: true };
    }

    const folders = [path];
    const entries: Array<Record<string, unknown>> = [];
    for (let index = 0; index < folders.length && entries.length <= limit; index += 1) {
      throwIfAborted(signal);
      const current = folders[index];
      if (!current) {
        continue;
      }
      const listed = await adapter.list(current);
      const children = [
        ...listed.folders.map((child) => ({ path: child, type: "folder" as const })),
        ...listed.files.map((child) => ({ path: child, type: "file" as const })),
      ].sort(comparePaths);
      for (const child of children) {
        if (entries.length > limit) {
          break;
        }
        const entry: Record<string, unknown> = { path: child.path, type: child.type };
        if (includeStats && child.type === "file") {
          const stat = await adapter.stat(child.path);
          if (stat) {
            entry.stats = { size: stat.size, ctime: stat.ctime, mtime: stat.mtime };
          }
        }
        entries.push(entry);
        if (recursive && child.type === "folder") {
          folders.push(child.path);
        }
      }
      if (!recursive) {
        break;
      }
    }
    const truncated = entries.length > limit;
    return {
      content: JSON.stringify({ path, entries: entries.slice(0, limit), cappedAt: limit, truncated }),
    };
  }

  private async inspect(rawPathValue: string, signal?: AbortSignal): Promise<ToolResult> {
    const path = safePath(rawPathValue);
    if (this.isConfigPath(path)) {
      throw new Error("vault_inspect is available only for visible vault files");
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      return { content: `File not found: ${path}`, isError: true };
    }
    const content = await this.app.vault.cachedRead(file);
    throwIfAborted(signal);
    const common = {
      path,
      hash: await sha256(content),
      stats: file.stat ? { size: file.stat.size, ctime: file.stat.ctime, mtime: file.stat.mtime } : undefined,
    };
    const structured = inspectStructuredFile(path, content);
    if (structured) {
      return { content: JSON.stringify({ ...common, ...structured }) };
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const contentLines = content.split("\n");

    const links = cap((cache?.links ?? []).map((link) => ({
      link: link.link,
      displayText: link.displayText,
      resolvedPath: this.app.metadataCache.getFirstLinkpathDest(link.link, path)?.path,
      line: link.position.start.line + 1,
    })));
    const embeds = cap((cache?.embeds ?? []).map((embed) => ({
      link: embed.link,
      displayText: embed.displayText,
      resolvedPath: this.app.metadataCache.getFirstLinkpathDest(embed.link, path)?.path,
      line: embed.position.start.line + 1,
    })));
    const backlinks = cap(Object.entries(this.app.metadataCache.resolvedLinks)
      .flatMap(([sourcePath, destinations]) => {
        const count = destinations[path] ?? 0;
        return count > 0 ? [{ path: sourcePath, count }] : [];
      }));
    const unresolvedLinks = cap(Object.entries(this.app.metadataCache.unresolvedLinks[path] ?? {})
      .map(([link, count]) => ({ link, count })));
    const tasks = cap((cache?.listItems ?? []).flatMap((item) => item.task === undefined ? [] : [{
      line: item.position.start.line + 1,
      status: item.task === " " ? "incomplete" : "complete",
      marker: item.task,
      text: contentLines[item.position.start.line] ?? "",
    }]));

    return {
      content: JSON.stringify({
        ...common,
        metadataPending: file.extension === "md" && !cache,
        properties: frontmatterProperties(cache?.frontmatter),
        headings: cap((cache?.headings ?? []).map((heading) => ({
          heading: heading.heading,
          level: heading.level,
          line: heading.position.start.line + 1,
        }))),
        blocks: cap(Object.entries(cache?.blocks ?? {}).map(([id, block]) => ({
          id,
          line: block.position.start.line + 1,
        }))),
        tags: cap(getAllTags(cache ?? {}) ?? []),
        links,
        embeds,
        backlinks,
        unresolvedLinks,
        tasks,
        cappedAt: MAX_INSPECT_ITEMS,
      }),
    };
  }

  private async prepareChange(args: Record<string, unknown>): Promise<PreparedChange> {
    const action = requireString(args, "action");
    const actions = ["create", "replace", "patch", "append", "copy", "move", "archive", "trash"];
    if (!actions.includes(action)) {
      throw new Error(`Unsupported vault_change action: ${action}`);
    }
    const path = safePath(requireString(args, "path"));
    if (this.isConfigPath(path)) {
      throw new Error("Bolovan stable does not modify Obsidian configuration or plugin code");
    }

    const existing = this.app.vault.getFileByPath(path);
    if (action === "create") {
      if (existing || this.app.vault.getAbstractFileByPath(path)) {
        throw new Error(`A vault item already exists at ${path}`);
      }
      const content = requireString(args, "content", true);
      validateStructuredFile(path, content);
      return {
        title: `Create ${path}`,
        message: exactPreview("create", path, undefined, content),
        diff: { before: "", after: content },
        apply: async () => {
          if (this.app.vault.getAbstractFileByPath(path)) {
            throw new Error(`${path} appeared after approval; nothing was written`);
          }
          await this.ensureParent(path);
          await this.app.vault.create(path, content);
          return { content: JSON.stringify({ action, path, hash: await sha256(content) }) };
        },
      };
    }
    if (!existing) {
      throw new Error(`File not found: ${path}`);
    }

    const beforeContent = await this.app.vault.read(existing);
    const expectedHash = requireString(args, "expected_hash");
    const actualHash = await sha256(beforeContent);
    if (expectedHash !== actualHash) {
      throw new Error(`Stale change for ${path}: expected ${expectedHash}, current ${actualHash}. Read it again.`);
    }

    if (action === "replace" || action === "append" || action === "patch") {
      const supplied = requireString(args, "content", true);
      let after: string;
      if (action === "replace") {
        after = supplied;
      } else if (action === "append") {
        after = `${beforeContent}${supplied}`;
      } else {
        const matched = requireString(args, "before");
        const occurrences = countOccurrences(beforeContent, matched);
        if (occurrences !== 1) {
          throw new Error(`patch before text must occur exactly once in ${path}; found ${occurrences}`);
        }
        after = beforeContent.replace(matched, supplied);
      }
      validateStructuredFile(path, after);
      return {
        title: `${action.charAt(0).toUpperCase()}${action.slice(1)} ${path}`,
        message: exactPreview(action, path, beforeContent, after),
        diff: { before: beforeContent, after },
        apply: async () => this.commitTextChange(existing, beforeContent, after, action),
      };
    }

    if (action === "copy" || action === "move") {
      const destination = safePath(requireString(args, "destination"));
      if (this.isConfigPath(destination)) {
        throw new Error("Bolovan stable does not modify Obsidian configuration or plugin code");
      }
      if (this.app.vault.getAbstractFileByPath(destination)) {
        throw new Error(`A vault item already exists at ${destination}`);
      }
      validateStructuredFile(destination, beforeContent);
      return {
        title: `${action.charAt(0).toUpperCase()}${action.slice(1)} ${path}`,
        message: `Exact approved operation\n\n${action.toUpperCase()}\n${path}\n→ ${destination}\n\nSource SHA-256: ${actualHash}`,
        apply: async () => {
          await assertUnchanged(this.app, existing, actualHash);
          if (this.app.vault.getAbstractFileByPath(destination)) {
            throw new Error(`${destination} appeared after approval; nothing was written`);
          }
          await this.ensureParent(destination);
          if (action === "copy") {
            await this.app.vault.copy(existing, destination);
          } else {
            await this.app.fileManager.renameFile(existing, destination);
          }
          return { content: JSON.stringify({ action, path, destination, hash: actualHash }) };
        },
      };
    }

    if (action === "trash") {
      return {
        title: `Trash ${path}`,
        message: `Exact approved operation\n\nTRASH\n${path}\n\nSource SHA-256: ${actualHash}\n\nObsidian will use the user's configured trash behavior.`,
        apply: async () => {
          await assertUnchanged(this.app, existing, actualHash);
          await this.app.fileManager.trashFile(existing);
          return { content: JSON.stringify({ action, path }) };
        },
      };
    }

    const archivePath = await this.availableArchivePath(path);
    return {
      title: `Archive ${path}`,
      message: `Exact approved operation\n\nARCHIVE\n${path}\n→ ${archivePath}\n\nSource SHA-256: ${actualHash}`,
      apply: async () => {
        await assertUnchanged(this.app, existing, actualHash);
        if (this.app.vault.getAbstractFileByPath(archivePath)) {
          throw new Error(`${archivePath} appeared after approval; nothing was written`);
        }
        await this.ensureParent(archivePath);
        await this.app.fileManager.renameFile(existing, archivePath);
        return { content: JSON.stringify({ action, path, destination: archivePath }) };
      },
    };
  }

  private async commitTextChange(file: TFile, before: string, after: string, action: string): Promise<ToolResult> {
    let stale = false;
    const written = await this.app.vault.process(file, (current) => {
      if (current !== before) {
        stale = true;
        return current;
      }
      return after;
    });
    if (stale) {
      throw new Error(`${file.path} changed after approval; nothing was written. Read it again.`);
    }
    return { content: JSON.stringify({ action, path: file.path, hash: await sha256(written) }) };
  }

  /** True for the vault's hidden config directory, whatever it is named. */
  private isConfigPath(path: string): boolean {
    const configDir = this.app.vault.configDir;
    return path === configDir || path.startsWith(`${configDir}/`);
  }

  private assertReadableConfigPath(path: string): void {
    const pluginRoot = `${this.app.vault.configDir}/plugins/bolovan`;
    if (path !== pluginRoot && !path.startsWith(`${pluginRoot}/`)) {
      throw new Error("Bolovan can only read its own plugin directory under Obsidian configuration");
    }
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getFolderByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async availableArchivePath(path: string): Promise<string> {
    const base = safePath(`archive/${path}`);
    if (!this.app.vault.getAbstractFileByPath(base)) {
      return base;
    }
    const dot = base.lastIndexOf(".");
    const stem = dot > base.lastIndexOf("/") ? base.slice(0, dot) : base;
    const extension = dot > base.lastIndexOf("/") ? base.slice(dot) : "";
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(`${stem}-${suffix}${extension}`)) {
      suffix += 1;
    }
    return `${stem}-${suffix}${extension}`;
  }
}

async function assertUnchanged(app: App, file: TFile, expectedHash: string): Promise<void> {
  if (await sha256(await app.vault.read(file)) !== expectedHash) {
    throw new Error(`${file.path} changed after approval; nothing was written. Read it again.`);
  }
}

function exactPreview(action: string, path: string, before: string | undefined, after: string): string {
  return [
    "Exact approved operation",
    "",
    action.toUpperCase(),
    path,
    "",
    before === undefined ? "New file contents:" : "Resulting full file contents:",
    "---",
    after,
    "---",
  ].join("\n");
}


function safePath(value: string): string {
  const normalized = normalizePath(value.trim().replace(/^\/+/, ""));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid vault path: ${value}`);
  }
  return normalized;
}

// Reads and listings may reach Bolovan's own config-directory subtree, but
// vault_change refuses every config-directory path before any preview or write.
function rawPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("path must be a non-empty string");
  }
  return value;
}

function requireString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalArgumentString(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${key} must be a string${allowEmpty ? "" : " when provided"}`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string, minimum: number): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`${key} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, key: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return Math.max(minimum, Math.min(maximum, value));
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}


function matchingProperty(
  frontmatter: Record<string, unknown> | undefined,
  wanted: string,
): { key: string; value: unknown } | undefined {
  if (!frontmatter) {
    return undefined;
  }
  const key = Object.keys(frontmatter)
    .find((candidate) => candidate !== "position" && candidate.toLocaleLowerCase() === wanted.toLocaleLowerCase());
  return key ? { key, value: frontmatter[key] } : undefined;
}

function propertyValueMatches(value: unknown, wanted: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => propertyValueMatches(item, wanted));
  }
  return String(value).toLocaleLowerCase() === wanted.toLocaleLowerCase();
}

function frontmatterProperties(frontmatter: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!frontmatter) {
    return {};
  }
  return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => key !== "position"));
}

function cap<T>(items: T[]): T[] {
  return items.slice(0, MAX_INSPECT_ITEMS);
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  return left.path.localeCompare(right.path);
}

function vaultEntry(file: TFile | TFolder, includeStats: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    path: file.path,
    type: file instanceof TFolder ? "folder" : "file",
  };
  if (includeStats && file instanceof TFile) {
    entry.stats = { size: file.stat.size, ctime: file.stat.ctime, mtime: file.stat.mtime };
  }
  return entry;
}

function countOccurrences(content: string, wanted: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - wanted.length) {
    const found = content.indexOf(wanted, offset);
    if (found === -1) {
      break;
    }
    count += 1;
    offset = found + wanted.length;
  }
  return count;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The response was stopped", "AbortError");
  }
}
