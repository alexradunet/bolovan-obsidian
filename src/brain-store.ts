import { normalizePath, type App } from "obsidian";
import type { ModelMessage } from "./model-adapter";
import {
  SkillStore,
  type ActivatedSkill,
  type SkillDiagnostic,
  type SkillSummary,
} from "./skills";

const MANIFEST_NAME = "bolovan-brain.json";
const MAX_AGENTS_CHARS = 40_000;

interface BrainManifest {
  format: 1;
  brainId: string;
  createdAt: string;
}

interface ConversationBranch {
  format: 1;
  conversationId: string;
  branchId: string;
  deviceId: string;
  createdAt: string;
  modifiedAt: string;
  title: string;
  model: string;
  messages: ModelMessage[];
}

export interface ConversationSummary {
  path: string;
  modifiedMs: number;
  label: string;
}

export interface BrainStoreOptions {
  folder: string;
  deviceId: string;
  activeBranch?: string;
  onFolderResolved?(folder: string): void;
  onActiveBranch?(path: string): void;
  onSkillDiagnostics?(diagnostics: SkillDiagnostic[]): void;
}

/**
 * Portable brain and conversation persistence. Every device writes only to
 * branches bearing its own id; opening another device's branch forks it on
 * first write, so sync conflicts are preserved instead of guessed together.
 */
export class BrainStore {
  private folder = "";
  private branches = new Map<string, ConversationBranch>();
  private activePath: string | undefined;
  private skills: SkillStore | undefined;

  constructor(
    private readonly app: App,
    private readonly options: BrainStoreOptions,
  ) {}

  async initialize(): Promise<void> {
    this.folder = await this.resolveFolder();
    await this.ensureStructure();
    this.skills = new SkillStore(this.app, this.folder, this.options.onSkillDiagnostics);
    await this.skills.discover();
    await this.reloadBranches();
    if (this.options.activeBranch && this.branches.has(this.options.activeBranch)) {
      this.activePath = this.options.activeBranch;
    }
    if (!this.activePath) {
      this.activePath = this.list()[0]?.path;
    }
    this.options.onFolderResolved?.(this.folder);
  }


  activeBranchPath(): string | undefined {
    return this.activePath;
  }

  skillFolderPath(): string {
    return `${this.folder}/Skills`;
  }

  messages(): ModelMessage[] {
    return [...(this.activePath ? this.branches.get(this.activePath)?.messages ?? [] : [])];
  }

  modelInfo(): { model: string } | undefined {
    const branch = this.activePath ? this.branches.get(this.activePath) : undefined;
    return branch ? { model: branch.model } : undefined;
  }

  list(): ConversationSummary[] {
    return [...this.branches.entries()]
      .map(([path, branch]) => ({
        path,
        modifiedMs: Date.parse(branch.modifiedAt) || 0,
        label: branch.title || formatDate(branch.createdAt),
      }))
      .sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  async append(messages: ModelMessage[], model: string): Promise<void> {
    const branch = await this.writableBranch(model);
    branch.messages.push(...messages);
    branch.model = model;
    branch.modifiedAt = new Date().toISOString();
    if (branch.title === "New conversation") {
      const firstUser = branch.messages.find((message) => message.role === "user")?.content ?? "";
      branch.title = titleFrom(firstUser);
    }
    await this.writeActive(branch);
  }

  async newConversation(model: string): Promise<string> {
    const now = new Date().toISOString();
    const conversationId = id("conversation");
    const branch: ConversationBranch = {
      format: 1,
      conversationId,
      branchId: id("branch"),
      deviceId: this.options.deviceId,
      createdAt: now,
      modifiedAt: now,
      title: "New conversation",
      model,
      messages: [],
    };
    const path = this.branchFilePath(branch);
    this.branches.set(path, branch);
    this.setActive(path);
    await this.createBranchFile(path, branch);
    return path;
  }

  async switch(path: string): Promise<void> {
    if (!this.branches.has(path)) {
      throw new Error(`Conversation branch not found: ${path}`);
    }
    this.setActive(path);
  }


  async instructions(): Promise<string> {
    const file = this.app.vault.getFileByPath(`${this.folder}/AGENTS.md`);
    const content = file ? await this.app.vault.cachedRead(file) : "";
    if (content.length > MAX_AGENTS_CHARS) {
      throw new Error(`Brain AGENTS.md exceeds ${MAX_AGENTS_CHARS} characters`);
    }
    return content;
  }

  async skillCatalog(): Promise<SkillSummary[]> {
    return (await this.skillStore().discover()).skills;
  }

  async activateSkill(name: string): Promise<ActivatedSkill> {
    return this.skillStore().activate(name);
  }

  async readSkillResource(name: string, path: string): Promise<string> {
    return this.skillStore().readResource(name, path);
  }

  private skillStore(): SkillStore {
    if (!this.skills) {
      throw new Error("The Brain is not initialized");
    }
    return this.skills;
  }

  private async writableBranch(model: string): Promise<ConversationBranch> {
    if (!this.activePath) {
      await this.newConversation(model);
    }
    const current = this.activePath ? this.branches.get(this.activePath) : undefined;
    if (!current) {
      throw new Error("Could not create a conversation branch");
    }
    if (current.deviceId === this.options.deviceId) {
      return current;
    }

    const fork: ConversationBranch = {
      ...current,
      branchId: id("branch"),
      deviceId: this.options.deviceId,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      messages: [...current.messages],
    };
    const path = this.branchFilePath(fork);
    this.branches.set(path, fork);
    this.setActive(path);
    await this.createBranchFile(path, fork);
    return fork;
  }

  private async writeActive(branch: ConversationBranch): Promise<void> {
    if (!this.activePath) {
      throw new Error("No active conversation branch");
    }
    const file = this.app.vault.getFileByPath(this.activePath);
    if (!file) {
      await this.createBranchFile(this.activePath, branch);
      return;
    }
    // process() keeps the write atomic against sync and other writers.
    await this.app.vault.process(file, () => `${JSON.stringify(branch, null, 2)}\n`);
  }

  private async createBranchFile(path: string, branch: ConversationBranch): Promise<void> {
    await this.app.vault.create(path, `${JSON.stringify(branch, null, 2)}\n`);
  }

  private branchFilePath(branch: ConversationBranch): string {
    return `${this.folder}/Sessions/${branch.conversationId}--${branch.deviceId}--${branch.branchId}.json`;
  }

  private setActive(path: string): void {
    this.activePath = path;
    this.options.onActiveBranch?.(path);
  }

  private async resolveFolder(): Promise<string> {
    const configured = safeFolder(this.options.folder);
    if (this.app.vault.getFileByPath(`${configured}/${MANIFEST_NAME}`)) {
      return configured;
    }
    const manifests = this.app.vault.getFiles()
      .filter((file) => file.name === MANIFEST_NAME)
      .sort((a, b) => a.path.localeCompare(b.path));
    if (manifests.length === 1) {
      return manifests[0]!.parent?.path ?? configured;
    }
    return configured;
  }

  private async ensureStructure(): Promise<void> {
    await ensureFolder(this.app, this.folder);
    for (const name of ["Skills", "Sessions"]) {
      await ensureFolder(this.app, `${this.folder}/${name}`);
    }
    if (!this.app.vault.getFileByPath(`${this.folder}/${MANIFEST_NAME}`)) {
      const manifest: BrainManifest = {
        format: 1,
        brainId: id("brain"),
        createdAt: new Date().toISOString(),
      };
      await this.app.vault.create(
        `${this.folder}/${MANIFEST_NAME}`,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
    const agentsPath = `${this.folder}/AGENTS.md`;
    if (!this.app.vault.getFileByPath(agentsPath)) {
      const legacy = this.app.vault.getFileByPath(`${this.folder}/Instructions.md`);
      if (legacy) {
        await this.app.fileManager.renameFile(legacy, agentsPath);
      } else {
        await this.app.vault.create(
          agentsPath,
          "# Bolovan instructions\n\nHelp the user work with this Obsidian vault. Use [[wikilinks]] when referring to notes. Read before changing, and keep changes focused.\n",
        );
      }
    }
  }

  private async reloadBranches(): Promise<void> {
    this.branches.clear();
    const prefix = `${this.folder}/Sessions/`;
    for (const file of this.app.vault.getFiles()) {
      if (!file.path.startsWith(prefix) || !file.path.endsWith(".json")) {
        continue;
      }
      try {
        const branch = JSON.parse(await this.app.vault.cachedRead(file)) as ConversationBranch;
        if (branch.format === 1 && Array.isArray(branch.messages)) {
          this.branches.set(file.path, branch);
        }
      } catch {
        // A sync-conflicted or partial file remains on disk and is ignored.
      }
    }
  }
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getFolderByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function safeFolder(folder: string): string {
  const normalized = normalizePath(folder.trim().replace(/^\/+|\/+$/g, ""));
  if (!normalized || normalized.startsWith(".") || normalized.includes("../")) {
    throw new Error("The Bolovan brain must be a visible folder inside the vault");
  }
  return normalized;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function titleFrom(content: string): string {
  const visible = content.replace(/<bolovan-attached-notes>[\s\S]*?<\/bolovan-attached-notes>\s*/i, "").trim();
  return visible.slice(0, 72) || "New conversation";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Conversation" : date.toLocaleString();
}
