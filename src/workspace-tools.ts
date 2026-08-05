import { MarkdownView, normalizePath, type App } from "obsidian";
import type { ToolDefinition } from "./model-adapter";
import type { ToolResult } from "./model-tools";

const MAX_SELECTION_CHARS = 40_000;

export const WORKSPACE_TOOL_DEFINITION: ToolDefinition = {
  name: "workspace",
  description: "Read the active Markdown editor context or open a visible vault file when the user asks to navigate. Opening never replaces Bolovan's chat view.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["context", "open"] },
      path: { type: "string", description: "Vault-relative file path required for open" },
      subpath: { type: "string", description: "Optional heading or block subpath beginning with #" },
      pane: { type: "string", enum: ["current", "tab", "split"], description: "Where to open; defaults to current Markdown pane or a safe new tab" },
    },
    required: ["action"],
  },
};

export class WorkspaceTools {
  constructor(private readonly app: App) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action;
    if (action === "context") {
      return this.context();
    }
    if (action === "open") {
      return this.open(args);
    }
    throw new Error(`Unsupported workspace action: ${String(action)}`);
  }

  private context(): ToolResult {
    const activeEditor = this.app.workspace.activeEditor;
    const file = activeEditor?.file ?? this.app.workspace.getActiveFile();
    const editor = activeEditor?.editor;
    if (!editor) {
      return {
        content: JSON.stringify({
          path: file?.path,
          hasEditor: false,
        }),
      };
    }

    const selection = editor.getSelection();
    const truncated = selection.length > MAX_SELECTION_CHARS;
    return {
      content: JSON.stringify({
        path: file?.path,
        hasEditor: true,
        cursor: editor.getCursor(),
        selections: editor.listSelections(),
        selection: selection.slice(0, MAX_SELECTION_CHARS),
        selectionChars: selection.length,
        selectionTruncated: truncated,
      }),
    };
  }

  private async open(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.path !== "string" || !args.path.trim()) {
      throw new Error("path must be a non-empty string");
    }
    const path = normalizePath(args.path.trim().replace(/^\/+/, ""));
    if (!path || path === "." || path.startsWith("../") || path.includes("/../")) {
      throw new Error(`Invalid vault path: ${args.path}`);
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }

    const subpath = args.subpath === undefined ? "" : args.subpath;
    if (typeof subpath !== "string" || (subpath && !subpath.startsWith("#"))) {
      throw new Error("subpath must be a string beginning with #");
    }
    const pane = args.pane ?? "current";
    if (pane !== "current" && pane !== "tab" && pane !== "split") {
      throw new Error(`Unsupported workspace pane: ${String(pane)}`);
    }

    const sourcePath = this.app.workspace.activeEditor?.file?.path ?? "";
    const linktext = `${file.path}${subpath}`;
    let openedIn = pane;
    if (pane === "current") {
      const markdownLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf
        ?? this.app.workspace.getLeavesOfType("markdown").at(-1);
      if (markdownLeaf) {
        this.app.workspace.setActiveLeaf(markdownLeaf, { focus: true });
        await this.app.workspace.openLinkText(linktext, sourcePath, false);
      } else {
        openedIn = "tab";
        await this.app.workspace.openLinkText(linktext, sourcePath, "tab");
      }
    } else {
      await this.app.workspace.openLinkText(linktext, sourcePath, pane);
    }

    return { content: JSON.stringify({ action: "open", path, subpath: subpath || undefined, pane: openedIn }) };
  }
}

