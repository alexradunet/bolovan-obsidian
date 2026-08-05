import { MarkdownView, TFile, type App, type Editor, type WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceTools } from "../src/workspace-tools";

function note(path: string): TFile {
  const file = new TFile();
  Object.assign(file, { path });
  return file;
}

describe("WorkspaceTools", () => {
  it("returns active in-memory selection context with a buffer hash", async () => {
    const file = note("Active.md");
    const editor = {
      getValue: () => "before selected after",
      getSelection: () => "selected",
      getCursor: () => ({ line: 0, ch: 15 }),
      listSelections: () => [{ anchor: { line: 0, ch: 7 }, head: { line: 0, ch: 15 } }],
    } as unknown as Editor;
    const app = {
      workspace: {
        activeEditor: { file, editor },
        getActiveFile: () => file,
      },
    } as unknown as App;

    const result = await new WorkspaceTools(app).execute({ action: "context" });
    const payload = JSON.parse(result.content);

    expect(payload).toMatchObject({
      path: "Active.md",
      hasEditor: true,
      cursor: { line: 0, ch: 15 },
      selection: "selected",
      selectionChars: 8,
      selectionTruncated: false,
      selections: [{ anchor: { line: 0, ch: 7 }, head: { line: 0, ch: 15 } }],
    });
    expect(payload.bufferHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("opens in the active Markdown leaf without replacing Bolovan's chat leaf", async () => {
    const file = note("Target.md");
    const markdownLeaf = { id: "markdown-leaf" } as unknown as WorkspaceLeaf;
    const setActiveLeaf = vi.fn();
    const openLinkText = vi.fn(async () => undefined);
    const app = {
      vault: { getFileByPath: (path: string) => path === file.path ? file : null },
      workspace: {
        activeEditor: { file: note("Source.md") },
        getActiveViewOfType: () => new MarkdownView(markdownLeaf),
        getLeavesOfType: () => [],
        setActiveLeaf,
        openLinkText,
      },
    } as unknown as App;

    const result = await new WorkspaceTools(app).execute({
      action: "open",
      path: "Target.md",
      subpath: "#Heading",
      pane: "current",
    });

    expect(result.isError).toBeUndefined();
    expect(setActiveLeaf).toHaveBeenCalledWith(markdownLeaf, { focus: true });
    expect(openLinkText).toHaveBeenCalledWith("Target.md#Heading", "Source.md", false);
    expect(JSON.parse(result.content)).toEqual({
      action: "open",
      path: "Target.md",
      subpath: "#Heading",
      pane: "current",
    });
  });

  it("uses a new normal tab when no Markdown leaf exists", async () => {
    const file = note("Target.md");
    const openLinkText = vi.fn(async () => undefined);
    const app = {
      vault: { getFileByPath: () => file },
      workspace: {
        activeEditor: null,
        getActiveViewOfType: () => null,
        getLeavesOfType: () => [],
        openLinkText,
      },
    } as unknown as App;

    const result = await new WorkspaceTools(app).execute({ action: "open", path: "Target.md" });

    expect(openLinkText).toHaveBeenCalledWith("Target.md", "", "tab");
    expect(JSON.parse(result.content).pane).toBe("tab");
  });

  it("rejects desktop-only popout navigation", async () => {
    const file = note("Target.md");
    const app = {
      vault: { getFileByPath: () => file },
      workspace: { activeEditor: null },
    } as unknown as App;

    const result = await new WorkspaceTools(app).execute({
      action: "open",
      path: "Target.md",
      pane: "window",
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("Unsupported workspace pane");
  });
});
