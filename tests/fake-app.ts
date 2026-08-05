import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";

export function fakeApp(initial: Record<string, string> = {}): App {
  const files = new Map(Object.entries(initial));
  const folders = new Set<string>([""]);

  for (const path of files.keys()) {
    addParentFolders(path, folders);
  }

  const fileAt = (path: string): TFile | null => {
    if (!files.has(path)) {
      return null;
    }
    const file = new TFile();
    Object.assign(file, {
      path,
      name: path.split("/").at(-1) ?? path,
      basename: (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, ""),
      extension: path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "",
      parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
    });
    return file;
  };

  const folderAt = (path: string): TFolder | null => {
    if (!folders.has(path)) {
      return null;
    }
    const folder = new TFolder();
    const prefix = path ? `${path}/` : "";
    const childPaths = new Set<string>();
    for (const folderPath of folders) {
      if (folderPath.startsWith(prefix) && folderPath !== path && !folderPath.slice(prefix.length).includes("/")) {
        childPaths.add(folderPath);
      }
    }
    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) {
        childPaths.add(filePath);
      }
    }
    Object.assign(folder, {
      path,
      children: [...childPaths].map((childPath) => fileAt(childPath) ?? folderAt(childPath)),
    });
    return folder;
  };

  const vault = {
    configDir: ".obsidian",
    getFileByPath: fileAt,
    getAbstractFileByPath: (path: string) => fileAt(path) ?? folderAt(path),
    getFolderByPath: folderAt,
    getRoot: () => folderAt(""),
    getFiles: () => [...files.keys()].map((path) => fileAt(path)),
    getMarkdownFiles: () => [...files.keys()]
      .filter((path) => path.endsWith(".md"))
      .map((path) => fileAt(path)),
    cachedRead: async (file: TFile) => files.get((file as TFile & { path: string }).path) ?? "",
    read: async (file: TFile) => files.get((file as TFile & { path: string }).path) ?? "",
    createFolder: async (path: string) => {
      folders.add(path);
      addParentFolders(`${path}/child`, folders);
      return folderAt(path);
    },
    create: async (path: string, content: string) => {
      if (files.has(path)) {
        throw new Error(`File already exists: ${path}`);
      }
      addParentFolders(path, folders);
      files.set(path, content);
      return fileAt(path);
    },
    process: async (file: TFile, change: (content: string) => string) => {
      const path = (file as TFile & { path: string }).path;
      const next = change(files.get(path) ?? "");
      files.set(path, next);
      return next;
    },
    adapter: {
      exists: async (path: string) => files.has(path) || folders.has(path),
      read: async (path: string) => files.get(path) ?? "",
      list: async (path: string) => {
        const prefix = path ? `${path}/` : "";
        return {
          files: [...files.keys()].filter((candidate) => candidate.startsWith(prefix)),
          folders: [...folders].filter((candidate) => candidate.startsWith(prefix) && candidate !== path),
        };
      },
    },
  };

  const app = {
    vault,
    fileManager: {
      renameFile: async (file: TFile, destination: string) => {
        const source = (file as TFile & { path: string }).path;
        const content = files.get(source);
        if (content === undefined) {
          throw new Error(`File not found: ${source}`);
        }
        files.delete(source);
        addParentFolders(destination, folders);
        files.set(destination, content);
      },
    },
  };

  return app as unknown as App;
}

function addParentFolders(path: string, folders: Set<string>): void {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    folders.add(current);
  }
}
