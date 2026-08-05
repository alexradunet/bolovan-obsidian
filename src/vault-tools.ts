import { normalizePath, TFile, TFolder, type App } from "obsidian";
import type { ToolDefinition } from "./model-adapter";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ChangePreview {
  title: string;
  message: string;
  apply(): Promise<ToolResult>;
}

export const VAULT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "vault_read",
    description: "Read one Markdown or text file from the Obsidian vault.",
    parameters: objectSchema({ path: { type: "string", description: "Vault-relative file path" } }, ["path"]),
  },
  {
    name: "vault_search",
    description: "Search Markdown file names and contents in the vault. Results are capped.",
    parameters: objectSchema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["query"]),
  },
  {
    name: "vault_list",
    description: "List files and folders immediately inside a vault folder.",
    parameters: objectSchema({ path: { type: "string", description: "Folder path; empty means vault root" } }),
  },
  {
    name: "vault_change",
    description: "Create, replace, append to, move, or archive a vault file. Every call requires user approval of an exact preview.",
    parameters: objectSchema({
      action: { type: "string", enum: ["create", "replace", "append", "move", "archive"] },
      path: { type: "string", description: "Current or new vault-relative file path" },
      content: { type: "string", description: "Full content for create/replace, or text to append" },
      destination: { type: "string", description: "Destination path for move" },
      expected_hash: { type: "string", description: "SHA-256 from vault_read; required when changing an existing file" },
    }, ["action", "path"]),
  },
];

export class VaultTools {
  constructor(private readonly app: App) {}

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult | ChangePreview> {
    try {
      if (name === "vault_read") {
        return await this.read(rawPath(args.path));
      }
      if (name === "vault_search") {
        return await this.search(requireString(args, "query"), boundedLimit(args.limit));
      }
      if (name === "vault_list") {
        return await this.list(optionalString(args.path));
      }
      if (name === "vault_change") {
        return await this.prepareChange(args);
      }
      return { content: `Unknown tool: ${name}`, isError: true };
    } catch (error) {
      return { content: describeError(error), isError: true };
    }
  }

  private async read(rawPath: string): Promise<ToolResult> {
    const path = safePath(rawPath);
    // Obsidian's Vault API never exposes the config directory; reads there
    // use the adapter directly. Writes stay sealed: vault_change refuses them.
    if (this.isConfigPath(path)) {
      this.assertReadableConfigPath(path);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) {
        return { content: `File not found: ${path}`, isError: true };
      }
      const content = await adapter.read(path);
      return { content: JSON.stringify({ path, hash: await sha256(content), content }) };
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      return { content: `File not found: ${path}`, isError: true };
    }
    const content = await this.app.vault.cachedRead(file);
    return {
      content: JSON.stringify({ path, hash: await sha256(content), content }),
    };
  }

  private async search(query: string, limit: number): Promise<ToolResult> {
    const wanted = query.toLocaleLowerCase();
    const results: Array<{ path: string; matches: string[] }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (results.length >= limit) {
        break;
      }
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split("\n");
      const matches = lines
        .filter((line) => line.toLocaleLowerCase().includes(wanted))
        .slice(0, 3)
        .map((line) => line.slice(0, 300));
      if (file.path.toLocaleLowerCase().includes(wanted) || matches.length) {
        results.push({ path: file.path, matches });
      }
    }
    return { content: JSON.stringify({ query, results, cappedAt: limit }) };
  }

  private async list(rawPath: string): Promise<ToolResult> {
    const path = rawPath ? safePath(rawPath) : "";
    // Same exception as vault_read: Obsidian's Vault API hides the config
    // directory.
    if (this.isConfigPath(path)) {
      this.assertReadableConfigPath(path);
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(path))) {
        return { content: `Folder not found: ${path}`, isError: true };
      }
      const listed = await adapter.list(path);
      const entries = [
        ...listed.folders.map((child) => ({ path: child, type: "folder" })),
        ...listed.files.map((child) => ({ path: child, type: "file" })),
      ];
      return { content: JSON.stringify({ path, entries }) };
    }
    const folder = path ? this.app.vault.getFolderByPath(path) : this.app.vault.getRoot();
    if (!folder) {
      return { content: `Folder not found: ${path}`, isError: true };
    }
    const entries = folder.children.map((child) => ({
      path: child.path,
      type: child instanceof TFolder ? "folder" : "file",
    }));
    return { content: JSON.stringify({ path, entries }) };
  }

  private async prepareChange(args: Record<string, unknown>): Promise<ChangePreview> {
    const action = requireString(args, "action");
    if (!["create", "replace", "append", "move", "archive"].includes(action)) {
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
      return {
        title: `Create ${path}`,
        message: exactPreview("create", path, undefined, content),
        apply: async () => {
          await this.ensureParent(path);
          await this.app.vault.create(path, content);
          return { content: JSON.stringify({ action, path, hash: await sha256(content) }) };
        },
      };
    }
    if (!existing) {
      throw new Error(`File not found: ${path}`);
    }

    const before = await this.app.vault.read(existing);
    const expectedHash = requireString(args, "expected_hash");
    const actualHash = await sha256(before);
    if (expectedHash !== actualHash) {
      throw new Error(`Stale change for ${path}: expected ${expectedHash}, current ${actualHash}. Read it again.`);
    }

    if (action === "replace" || action === "append") {
      const supplied = requireString(args, "content", true);
      const after = action === "replace" ? supplied : `${before}${supplied}`;
      return {
        title: `${capitalize(action)} ${path}`,
        message: exactPreview(action, path, before, after),
        apply: async () => {
          let stale = false;
          const written = await this.app.vault.process(existing, (current) => {
            if (current !== before) {
              stale = true;
              return current;
            }
            return after;
          });
          if (stale) {
            throw new Error(`${path} changed after approval; nothing was written. Read it again.`);
          }
          return { content: JSON.stringify({ action, path, hash: await sha256(written) }) };
        },
      };
    }

    if (action === "move") {
      const destination = safePath(requireString(args, "destination"));
      if (this.isConfigPath(destination)) {
        throw new Error("Bolovan stable does not modify Obsidian configuration or plugin code");
      }
      if (this.app.vault.getAbstractFileByPath(destination)) {
        throw new Error(`A vault item already exists at ${destination}`);
      }
      return {
        title: `Move ${path}`,
        message: `Exact approved operation\n\nMOVE\n${path}\n→ ${destination}\n\nSource SHA-256: ${actualHash}`,
        apply: async () => {
          await assertUnchanged(this.app, existing, actualHash);
          await this.ensureParent(destination);
          await this.app.fileManager.renameFile(existing, destination);
          return { content: JSON.stringify({ action, path, destination }) };
        },
      };
    }

    const archivePath = await this.availableArchivePath(path);
    return {
      title: `Archive ${path}`,
      message: `Exact approved operation\n\nARCHIVE\n${path}\n→ ${archivePath}\n\nSource SHA-256: ${actualHash}`,
      apply: async () => {
        await assertUnchanged(this.app, existing, actualHash);
        await this.ensureParent(archivePath);
        await this.app.fileManager.renameFile(existing, archivePath);
        return { content: JSON.stringify({ action, path, destination: archivePath }) };
      },
    };
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

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedLimit(value: unknown): number {
  const number = typeof value === "number" ? Math.floor(value) : 20;
  return Math.max(1, Math.min(50, number));
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

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
