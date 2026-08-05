import { describe, expect, it } from "vitest";

import type { App, CachedMetadata, TFile } from "obsidian";
import { VaultTools } from "../src/vault-tools";
import type { PreparedChange, ToolResult } from "../src/model-tools";
import { fakeApp } from "./fake-app";

/** Direct tool results carry content; prepared changes carry apply(). */
function contentOf(result: ToolResult | PreparedChange): string {
  if ("apply" in result) {
    throw new Error("Expected a direct tool result, got a prepared change");
  }
  return result.content;
}

function asPreparedChange(result: ToolResult | PreparedChange): PreparedChange {
  if ("apply" in result) {
    return result;
  }
  throw new Error("Expected a prepared change, got a direct tool result");
}

function setMetadata(
  app: App,
  caches: Record<string, CachedMetadata>,
  resolvedLinks: Record<string, Record<string, number>> = {},
  unresolvedLinks: Record<string, Record<string, number>> = {},
): void {
  Object.assign(app, {
    metadataCache: {
      getFileCache: (file: TFile) => caches[file.path] ?? null,
      getFirstLinkpathDest: (link: string) => app.vault.getFileByPath(link),
      resolvedLinks,
      unresolvedLinks,
    },
  });
}

function position(line: number, offset: number, endOffset = offset + 1) {
  const start = { line, col: 0, offset };
  const end = { line, col: 0, offset: endOffset };
  return { start, end };
}

describe("VaultTools reads and discovery", () => {
  it("returns bounded line content with the whole-file hash", async () => {
    const tools = new VaultTools(fakeApp({ "Note.md": "one\ntwo\nthree\nfour" }));

    const result = await tools.execute("vault_read", {
      path: "Note.md",
      start_line: 2,
      end_line: 3,
    });

    expect(JSON.parse(contentOf(result))).toMatchObject({
      path: "Note.md",
      range: { startLine: 2, endLine: 3 },
      content: "two\nthree",
      totalChars: 9,
      truncated: false,
    });
    expect(JSON.parse(contentOf(result)).hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads one heading through Obsidian metadata", async () => {
    const content = "# Intro\nintro\n## Target\nbody\n## Next\nlater";
    const app = fakeApp({ "Note.md": content });
    setMetadata(app, {
      "Note.md": {
        headings: [
          { heading: "Intro", level: 1, position: position(0, 0, 7) },
          { heading: "Target", level: 2, position: position(2, 14, 23) },
          { heading: "Next", level: 2, position: position(4, 29, 36) },
        ],
      },
    });
    const tools = new VaultTools(app);

    const result = await tools.execute("vault_read", { path: "Note.md", subpath: "#Target" });

    expect(JSON.parse(contentOf(result))).toMatchObject({
      subpath: "#Target",
      range: { startLine: 3, endLine: 4 },
      content: "## Target\nbody\n",
    });
  });

  it("lists bounded descendants with file statistics", async () => {
    const app = fakeApp({
      "Folder/A.md": "a",
      "Folder/Nested/B.md": "bb",
    });
    const tools = new VaultTools(app);

    const result = await tools.execute("vault_list", {
      path: "Folder",
      recursive: true,
      include_stats: true,
      limit: 10,
    });
    const payload = JSON.parse(contentOf(result));

    expect(payload.truncated).toBe(false);
    expect(payload.entries).toEqual(expect.arrayContaining([
      { path: "Folder/A.md", type: "file", stats: { size: 1, ctime: 1, mtime: 2 } },
      { path: "Folder/Nested", type: "folder" },
      { path: "Folder/Nested/B.md", type: "file", stats: { size: 2, ctime: 1, mtime: 2 } },
    ]));
  });

  it("combines structured metadata filters", async () => {
    const app = fakeApp({
      "Project.md": "alpha\n- [ ] do it",
      "Other.md": "alpha",
      "Target.md": "target",
    });
    setMetadata(app, {
      "Project.md": {
        tags: [{ tag: "#work", position: position(0, 0) }],
        frontmatter: { status: "open" },
        listItems: [{ task: " ", parent: -1, position: position(1, 6) }],
      },
      "Other.md": { tags: [{ tag: "#work", position: position(0, 0) }] },
      "Target.md": {},
    }, {
      "Project.md": { "Target.md": 1 },
    });
    const tools = new VaultTools(app);

    const result = await tools.execute("vault_search", {
      tag: "work",
      property: "status",
      property_value: "open",
      linked_to: "Target.md",
      task_status: "incomplete",
    });
    const payload = JSON.parse(contentOf(result));

    expect(payload.results).toEqual([expect.objectContaining({
      path: "Project.md",
      reasons: ["tag:#work", "property:status=open", "linked_to:Target.md", "task_status:incomplete"],
    })]);
  });

  it("stops a content scan when the run is cancelled", async () => {
    const app = fakeApp({ "A.md": "alpha", "B.md": "alpha" });
    const controller = new AbortController();
    const cachedRead = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (file) => {
      const content = await cachedRead(file);
      controller.abort();
      return content;
    };
    const tools = new VaultTools(app);

    await expect(tools.execute("vault_search", { query: "alpha" }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("inspects properties, links, backlinks, blocks, tags, and tasks", async () => {
    const app = fakeApp({
      "Project.md": "# Project\n- [ ] do it\n[[Target.md]]",
      "Target.md": "target",
      "Back.md": "[[Project.md]]",
    });
    setMetadata(app, {
      "Project.md": {
        frontmatter: { status: "open", position: position(0, 0) },
        headings: [{ heading: "Project", level: 1, position: position(0, 0, 9) }],
        blocks: { project: { id: "project", position: position(0, 0, 9) } },
        tags: [{ tag: "#work", position: position(0, 0) }],
        links: [{ link: "Target.md", original: "[[Target.md]]", position: position(2, 22, 35) }],
        listItems: [{ task: " ", parent: -1, position: position(1, 10, 21) }],
      },
      "Target.md": {},
      "Back.md": {},
    }, {
      "Project.md": { "Target.md": 1 },
      "Back.md": { "Project.md": 2 },
    }, {
      "Project.md": { Missing: 1 },
    });
    const tools = new VaultTools(app);

    const result = await tools.execute("vault_inspect", { path: "Project.md" });
    const payload = JSON.parse(contentOf(result));

    expect(payload).toMatchObject({
      path: "Project.md",
      metadataPending: false,
      properties: { status: "open" },
      headings: [{ heading: "Project", level: 1, line: 1 }],
      blocks: [{ id: "project", line: 1 }],
      tags: ["#work"],
      links: [{ link: "Target.md", resolvedPath: "Target.md", line: 3 }],
      backlinks: [{ path: "Back.md", count: 2 }],
      unresolvedLinks: [{ link: "Missing", count: 1 }],
      tasks: [{ line: 2, status: "incomplete", marker: " ", text: "- [ ] do it" }],
    });
    expect(payload.hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("paginates exact source in long single-line structured files", async () => {
    const content = `${"x".repeat(40_005)}target`;
    const tools = new VaultTools(fakeApp({ "Board.canvas": content }));

    const first = JSON.parse(contentOf(await tools.execute("vault_read", {
      path: "Board.canvas",
      start_char: 0,
    })));
    const second = JSON.parse(contentOf(await tools.execute("vault_read", {
      path: "Board.canvas",
      start_char: first.nextStartChar,
    })));

    expect(first).toMatchObject({
      range: { startChar: 0, endChar: 40_000 },
      sourceChars: 40_011,
      nextStartChar: 40_000,
      truncated: true,
    });
    expect(second).toMatchObject({
      range: { startChar: 40_000, endChar: 40_011 },
      content: "xxxxxtarget",
      truncated: false,
    });
  });

  it("discovers and searches Canvas and Bases source separately from Markdown", async () => {
    const app = fakeApp({
      "Board.canvas": `${"x".repeat(500)}needle`,
      "Dashboard.base": "{\"views\":[]}",
      "Note.md": "needle",
    });
    const tools = new VaultTools(app);

    const canvas = JSON.parse(contentOf(await tools.execute("vault_search", {
      extension: "canvas",
      query: "needle",
    })));
    const bases = JSON.parse(contentOf(await tools.execute("vault_search", {
      extension: "base",
    })));

    expect(canvas.results).toEqual([expect.objectContaining({
      path: "Board.canvas",
      matches: [expect.stringContaining("needle")],
    })]);
    expect(bases.results).toEqual([{ path: "Dashboard.base", matches: [], reasons: [] }]);
  });

  it("inspects validated Canvas structure while preserving unknown keys", async () => {
    const content = JSON.stringify({
      nodes: [
        { id: "group", type: "group", x: 0, y: 0, width: 800, height: 600, future: true },
        { id: "note", type: "file", file: "Note.md", subpath: "#Plan", x: 50, y: 50, width: 300, height: 200 },
      ],
      edges: [
        { id: "edge", fromNode: "group", toNode: "note", fromSide: "right", toEnd: "arrow", future: "kept" },
      ],
      futureRoot: { version: 2 },
    });
    const tools = new VaultTools(fakeApp({ "Board.canvas": content }));

    const result = JSON.parse(contentOf(await tools.execute("vault_inspect", { path: "Board.canvas" })));

    expect(result).toMatchObject({
      format: "canvas",
      nodeCount: 2,
      edgeCount: 1,
      nodes: [
        { index: 0, id: "group", type: "group", future: true },
        { index: 1, id: "note", type: "file", file: "Note.md", subpath: "#Plan" },
      ],
      edges: [{ index: 0, id: "edge", fromNode: "group", toNode: "note", future: "kept" }],
      truncated: false,
    });
  });

  it("inspects Bases configuration without claiming formula evaluation", async () => {
    const content = JSON.stringify({
      filters: { and: ["file.ext == \"md\"", { not: ["status == \"done\""] }] },
      formulas: { recent: "file.mtime > now() - \"1 week\"" },
      properties: { status: { displayName: "Status", future: true } },
      views: [{ type: "table", name: "Active", order: ["file.name"], future: { density: "compact" } }],
      futureRoot: true,
    });
    const tools = new VaultTools(fakeApp({ "Dashboard.base": content }));

    const result = JSON.parse(contentOf(await tools.execute("vault_inspect", { path: "Dashboard.base" })));

    expect(result).toMatchObject({
      format: "base",
      expressionsEvaluated: false,
      config: {
        formulas: { recent: "file.mtime > now() - \"1 week\"" },
        properties: { status: { displayName: "Status", future: true } },
        views: [{ type: "table", name: "Active", future: { density: "compact" } }],
        futureRoot: true,
      },
      truncated: false,
    });
  });

});

describe("VaultTools exact changes", () => {
  it("applies a unique patch and rejects ambiguous source text", async () => {
    const app = fakeApp({ "Note.md": "before middle after" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });
    const hash = JSON.parse(contentOf(read)).hash;

    const prepared = await tools.execute("vault_change", {
      action: "patch",
      path: "Note.md",
      before: "middle",
      content: "changed",
      expected_hash: hash,
    });
    expect(asPreparedChange(prepared).message).toContain("before changed after");
    await asPreparedChange(prepared).apply();
    expect(await app.vault.cachedRead(app.vault.getFileByPath("Note.md")!)).toBe("before changed after");

    const nextRead = await tools.execute("vault_read", { path: "Note.md" });
    await expect(tools.execute("vault_change", {
      action: "patch",
      path: "Note.md",
      before: "e",
      content: "x",
      expected_hash: JSON.parse(contentOf(nextRead)).hash,
    })).rejects.toThrow("must occur exactly once");
  });

  it("rejects an approved text change when the source changes before commit", async () => {
    const app = fakeApp({ "Note.md": "before" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });
    const prepared = await tools.execute("vault_change", {
      action: "replace",
      path: "Note.md",
      content: "after",
      expected_hash: JSON.parse(contentOf(read)).hash,
    });

    await app.vault.process(app.vault.getFileByPath("Note.md")!, () => "changed elsewhere");
    await expect(asPreparedChange(prepared).apply()).rejects.toThrow("changed after approval");
    expect(await app.vault.cachedRead(app.vault.getFileByPath("Note.md")!)).toBe("changed elsewhere");
  });

  it("copies and trashes files through Obsidian APIs", async () => {
    const app = fakeApp({ "Note.md": "content" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });

    const copy = await tools.execute("vault_change", {
      action: "copy",
      path: "Note.md",
      destination: "Copies/Note.md",
      expected_hash: JSON.parse(contentOf(read)).hash,
    });
    await asPreparedChange(copy).apply();
    expect(await app.vault.cachedRead(app.vault.getFileByPath("Copies/Note.md")!)).toBe("content");

    const copiedRead = await tools.execute("vault_read", { path: "Copies/Note.md" });
    const trash = await tools.execute("vault_change", {
      action: "trash",
      path: "Copies/Note.md",
      expected_hash: JSON.parse(contentOf(copiedRead)).hash,
    });
    await asPreparedChange(trash).apply();
    expect(app.vault.getFileByPath("Copies/Note.md")).toBeNull();
  });

  it("refuses stable-channel writes under the config directory", async () => {
    const tools = new VaultTools(fakeApp());
    await expect(tools.execute("vault_change", {
      action: "create",
      path: ".obsidian/plugins/generated/main.ts",
      content: "unsafe",
    })).rejects.toThrow("does not modify Obsidian configuration or plugin code");
  });

  it("reads and lists only Bolovan's own hidden source subtree", async () => {
    const app = fakeApp({
      ".obsidian/plugins/bolovan/src/vault-tools.ts": "source code",
      ".obsidian/app.json": "{}",
      ".obsidian/plugins/other-plugin/data.json": "secret",
    });
    const tools = new VaultTools(app);

    const read = await tools.execute("vault_read", { path: ".obsidian/plugins/bolovan/src/vault-tools.ts" });
    expect(JSON.parse(contentOf(read)).content).toBe("source code");
    const listed = await tools.execute("vault_list", { path: ".obsidian/plugins/bolovan/src" });
    expect(JSON.parse(contentOf(listed)).entries).toContainEqual({
      path: ".obsidian/plugins/bolovan/src/vault-tools.ts",
      type: "file",
    });

    await expect(tools.execute("vault_read", { path: ".obsidian/app.json" }))
      .rejects.toThrow("only read its own plugin directory");
    await expect(tools.execute("vault_list", { path: ".obsidian/plugins/other-plugin" }))
      .rejects.toThrow("only read its own plugin directory");
  });

  it("follows a renamed config directory and blocks moves into it", async () => {
    const app = fakeApp({ ".config/plugins/bolovan/main.js": "source", "Note.md": "before" });
    app.vault.configDir = ".config";
    const tools = new VaultTools(app);

    const source = await tools.execute("vault_read", { path: ".config/plugins/bolovan/main.js" });
    expect(JSON.parse(contentOf(source)).content).toBe("source");
    const note = await tools.execute("vault_read", { path: "Note.md" });
    await expect(tools.execute("vault_change", {
      action: "move",
      path: "Note.md",
      destination: ".config/plugins/bolovan/copied.md",
      expected_hash: JSON.parse(contentOf(note)).hash,
    })).rejects.toThrow("does not modify Obsidian configuration");
  });
  it("rejects malformed Canvas and Bases content before approval", async () => {
    const tools = new VaultTools(fakeApp());
    const danglingCanvas = JSON.stringify({
      nodes: [{ id: "one", type: "text", text: "One", x: 0, y: 0, width: 200, height: 100 }],
      edges: [{ id: "edge", fromNode: "one", toNode: "missing" }],
    });

    await expect(tools.execute("vault_change", {
      action: "create",
      path: "Broken.canvas",
      content: danglingCanvas,
    })).rejects.toThrow("references a missing node");
    await expect(tools.execute("vault_change", {
      action: "create",
      path: "Broken.base",
      content: JSON.stringify({ filters: { maybe: ["status == \"open\""] }, views: [] }),
    })).rejects.toThrow("must contain one and, or, or not array");
  });

  it("validates resulting structured patches and copy destinations", async () => {
    const baseContent = JSON.stringify({
      filters: { and: ["status == \"open\""] },
      views: [{ type: "table", name: "Open" }],
    });
    const canvasContent = JSON.stringify({
      nodes: [{ id: "one", type: "text", text: "One", x: 0, y: 0, width: 200, height: 100 }],
      edges: [],
    });
    const app = fakeApp({
      "Dashboard.base": baseContent,
      "Board.canvas": canvasContent,
      "Note.md": "not canvas json",
    });
    const tools = new VaultTools(app);

    const baseRead = JSON.parse(contentOf(await tools.execute("vault_read", { path: "Dashboard.base" })));
    const validPatch = await tools.execute("vault_change", {
      action: "patch",
      path: "Dashboard.base",
      before: "\"Open\"",
      content: "\"Active\"",
      expected_hash: baseRead.hash,
    });
    await asPreparedChange(validPatch).apply();
    expect(await app.vault.cachedRead(app.vault.getFileByPath("Dashboard.base")!)).toContain("\"Active\"");

    const canvasRead = JSON.parse(contentOf(await tools.execute("vault_read", { path: "Board.canvas" })));
    await expect(tools.execute("vault_change", {
      action: "patch",
      path: "Board.canvas",
      before: "\"id\":\"one\"",
      content: "\"id\":\"\"",
      expected_hash: canvasRead.hash,
    })).rejects.toThrow("must be a non-empty string");
    const noteRead = JSON.parse(contentOf(await tools.execute("vault_read", { path: "Note.md" })));
    await expect(tools.execute("vault_change", {
      action: "copy",
      path: "Note.md",
      destination: "Copied.canvas",
      expected_hash: noteRead.hash,
    })).rejects.toThrow("Invalid Canvas JSON");
    expect(app.vault.getFileByPath("Copied.canvas")).toBeNull();
  });

});
