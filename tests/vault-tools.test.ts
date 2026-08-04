import { describe, expect, it } from "vitest";

import { VaultTools } from "../src/vault-tools";

function fakeApp(initial: Record<string, string>): { app: any; files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const file = (path: string) => files.has(path) ? { path } : null;
  const vault = {
    getFileByPath: file,
    getAbstractFileByPath: file,
    getFolderByPath: () => ({ children: [] }),
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
  };
  return { app: { vault, fileManager: { renameFile: async () => undefined } }, files };
}

describe("VaultTools exact changes", () => {
  it("binds a replacement to the hash returned by vault_read", async () => {
    const { app, files } = fakeApp({ "Note.md": "before" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });
    expect("apply" in read).toBe(false);
    const hash = JSON.parse((read as any).content).hash;

    const prepared = await tools.execute("vault_change", {
      action: "replace",
      path: "Note.md",
      content: "after",
      expected_hash: hash,
    });
    expect("apply" in prepared).toBe(true);
    expect((prepared as any).message).toContain("Resulting full file contents:\n---\nafter\n---");
    await (prepared as any).apply();

    expect(files.get("Note.md")).toBe("after");
  });

  it("rejects an approved replacement when the source changes before commit", async () => {
    const { app, files } = fakeApp({ "Note.md": "before" });
    const tools = new VaultTools(app);
    const read = await tools.execute("vault_read", { path: "Note.md" });
    const hash = JSON.parse((read as any).content).hash;
    const prepared = await tools.execute("vault_change", {
      action: "replace",
      path: "Note.md",
      content: "after",
      expected_hash: hash,
    });

    files.set("Note.md", "changed elsewhere");
    await expect((prepared as any).apply()).rejects.toThrow("changed after approval");
    expect(files.get("Note.md")).toBe("changed elsewhere");
  });

  it("refuses stable-channel writes under .obsidian", async () => {
    const { app } = fakeApp({});
    const tools = new VaultTools(app);
    const result = await tools.execute("vault_change", {
      action: "create",
      path: ".obsidian/plugins/generated/main.ts",
      content: "unsafe",
    });

    expect(result).toMatchObject({ isError: true });
    expect((result as any).content).toContain("does not modify Obsidian configuration or plugin code");
  });
});
