import { describe, expect, it } from "vitest";

import { VaultTools } from "../src/vault-tools";

function fakeApp(initial: Record<string, string>): { app: any; files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const file = (path: string) => files.has(path) ? { path } : null;
  const vault = {
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

  it("reads and lists the plugin's own source through the adapter", async () => {
    const { app, files } = fakeApp({ ".obsidian/plugins/bolovan/src/vault-tools.ts": "source code" });
    const tools = new VaultTools(app);

    const read = await tools.execute("vault_read", { path: ".obsidian/plugins/bolovan/src/vault-tools.ts" });
    const payload = JSON.parse((read as { content: string }).content);
    expect(payload).toMatchObject({
      path: ".obsidian/plugins/bolovan/src/vault-tools.ts",
      content: "source code",
    });

    const listed = await tools.execute("vault_list", { path: ".obsidian/plugins/bolovan/src" });
    const entries = JSON.parse((listed as { content: string }).content).entries;
    expect(entries).toContainEqual({
      path: ".obsidian/plugins/bolovan/src/vault-tools.ts",
      type: "file",
    });

    files.delete(".obsidian/plugins/bolovan/src/vault-tools.ts");
    const missing = await tools.execute("vault_read", { path: ".obsidian/plugins/bolovan/src/vault-tools.ts" });
    expect(missing).toMatchObject({ isError: true });
    expect((missing as { content: string }).content).toContain("File not found");
  });
});
