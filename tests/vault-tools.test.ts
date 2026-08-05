import { describe, expect, it } from "vitest";

import type { App } from "obsidian";
import { VaultTools, type ChangePreview, type ToolResult } from "../src/vault-tools";

function fakeApp(initial: Record<string, string>, configDir = ".obsidian"): { app: App; files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const file = (path: string) => files.has(path) ? { path } : null;
  const vault = {
    configDir,
    getFileByPath: file,
    getAbstractFileByPath: file,
    getFolderByPath: () => null,
    getRoot: () => ({ children: [] }),
    getMarkdownFiles: () => [...files.keys()].map((path) => ({ path })),
    cachedRead: async (target: { path: string }) => files.get(target.path) ?? "",
    read: async (target: { path: string }) => files.get(target.path) ?? "",
    process: async (target: { path: string }, change: (content: string) => string) => {
      const written = change(files.get(target.path) ?? "");
      files.set(target.path, written);
      return written;
    },
    create: async (path: string, content: string) => {
      files.set(path, content);
      return { path };
    },
    createFolder: async () => undefined,
    adapter: {
      exists: async (path: string) => files.has(path) || [...files.keys()].some((child) => child.startsWith(`${path}/`)),
      read: async (path: string) => files.get(path) ?? "",
      list: async (path: string) => {
        const prefix = `${path}/`;
        const folders = new Set<string>();
        const filesHere: string[] = [];
        for (const child of files.keys()) {
          if (!child.startsWith(prefix)) {
            continue;
          }
          const rest = child.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash === -1) {
            filesHere.push(child);
          } else {
            folders.add(`${prefix}${rest.slice(0, slash)}`);
          }
        }
        return { files: filesHere, folders: [...folders] };
      },
    },
  };
  // Structural fake, not a real App: the test seam for vault tools.
  const app = { vault, fileManager: { renameFile: async () => undefined } } as unknown as App;
  return { app, files };
}

/** Direct tool results carry content; previews carry apply(). */
function contentOf(result: ToolResult | ChangePreview): string {
  if ("apply" in result) {
    throw new Error("Expected a direct tool result, got a change preview");
  }
  return result.content;
}

function asChangePreview(result: ToolResult | ChangePreview): ChangePreview {
  if ("apply" in result) {
    return result;
  }
  throw new Error("Expected a change preview, got a direct tool result");
}

describe("VaultTools exact changes", () => {
  it("binds a replacement to the hash returned by vault_read", async () => {
    const { app, files } = fakeApp({ "Note.md": "before" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });
    expect("apply" in read).toBe(false);
    const hash = JSON.parse(contentOf(read)).hash;

    const prepared = await tools.execute("vault_change", {
      action: "replace",
      path: "Note.md",
      content: "after",
      expected_hash: hash,
    });
    expect("apply" in prepared).toBe(true);
    expect(asChangePreview(prepared).message).toContain("Resulting full file contents:\n---\nafter\n---");
    await asChangePreview(prepared).apply();

    expect(files.get("Note.md")).toBe("after");
  });

  it("rejects an approved replacement when the source changes before commit", async () => {
    const { app, files } = fakeApp({ "Note.md": "before" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });
    const hash = JSON.parse(contentOf(read)).hash;
    const prepared = await tools.execute("vault_change", {
      action: "replace",
      path: "Note.md",
      content: "after",
      expected_hash: hash,
    });

    files.set("Note.md", "changed elsewhere");
    await expect(asChangePreview(prepared).apply()).rejects.toThrow("changed after approval");
    expect(files.get("Note.md")).toBe("changed elsewhere");
  });

  it("refuses stable-channel writes under the config directory", async () => {
    const { app } = fakeApp({});
    const tools = new VaultTools(app);
    const result = await tools.execute("vault_change", {
      action: "create",
      path: ".obsidian/plugins/generated/main.ts",
      content: "unsafe",
    });

    expect("apply" in result).toBe(false);
    expect(contentOf(result)).toContain("does not modify Obsidian configuration or plugin code");
  });

  it("reads and lists the plugin's own source through the adapter", async () => {
    const { app, files } = fakeApp({ ".obsidian/plugins/bolovan/src/vault-tools.ts": "source code" });
    const tools = new VaultTools(app);

    const read = await tools.execute("vault_read", { path: ".obsidian/plugins/bolovan/src/vault-tools.ts" });
    const payload = JSON.parse(contentOf(read));
    expect(payload).toMatchObject({
      path: ".obsidian/plugins/bolovan/src/vault-tools.ts",
      content: "source code",
    });

    const listed = await tools.execute("vault_list", { path: ".obsidian/plugins/bolovan/src" });
    const entries = JSON.parse(contentOf(listed)).entries;
    expect(entries).toContainEqual({
      path: ".obsidian/plugins/bolovan/src/vault-tools.ts",
      type: "file",
    });

    files.delete(".obsidian/plugins/bolovan/src/vault-tools.ts");
    const missing = await tools.execute("vault_read", { path: ".obsidian/plugins/bolovan/src/vault-tools.ts" });
    expect(contentOf(missing)).toContain("File not found");
  });

  it("refuses reads and listings outside Bolovan's config subtree", async () => {
    const { app } = fakeApp({
      ".obsidian/app.json": "{\"legacyEditor\":false}",
      ".obsidian/plugins/other-plugin/data.json": "{\"token\":\"secret\"}",
    });
    const tools = new VaultTools(app);

    const settings = await tools.execute("vault_read", { path: ".obsidian/app.json" });
    expect(contentOf(settings)).toContain("only read its own plugin directory");

    const otherPlugin = await tools.execute("vault_list", { path: ".obsidian/plugins/other-plugin" });
    expect(contentOf(otherPlugin)).toContain("only read its own plugin directory");
  });

  it("follows a renamed config directory instead of assuming .obsidian", async () => {
    const { app } = fakeApp({ ".config/plugins/bolovan/main.js": "source" }, ".config");
    const tools = new VaultTools(app);

    const read = await tools.execute("vault_read", { path: ".config/plugins/bolovan/main.js" });
    expect(JSON.parse(contentOf(read)).content).toBe("source");

    const blocked = await tools.execute("vault_change", {
      action: "create",
      path: ".config/evil.md",
      content: "unsafe",
    });
    expect("apply" in blocked).toBe(false);
    expect(contentOf(blocked)).toContain("does not modify Obsidian configuration");
  });

  it("refuses to move a note into the config directory", async () => {
    const { app } = fakeApp({ "Note.md": "before" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });
    const hash = JSON.parse(contentOf(read)).hash;

    const blocked = await tools.execute("vault_change", {
      action: "move",
      path: "Note.md",
      destination: ".obsidian/plugins/bolovan/copied.md",
      expected_hash: hash,
    });
    expect("apply" in blocked).toBe(false);
    expect(contentOf(blocked)).toContain("does not modify Obsidian configuration");
  });
});
