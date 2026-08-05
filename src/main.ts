import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  type SettingDefinitionItem,
  TFile,
} from "obsidian";
import { BOLOVAN_CHAT_VIEW, BolovanChatView } from "./chat-view";
import { BolovanAgent } from "./bolovan-agent";
import type { ProviderConfig, ThinkingEffort } from "./model-adapter";

const API_KEY_SECRET = "bolovan-openai-api-key";
const THINKING_LEVELS: ReadonlyArray<{ id: ThinkingEffort; name: string }> = [
  { id: "none", name: "None — lowest latency" },
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium — balanced" },
  { id: "high", name: "High" },
  { id: "xhigh", name: "Extra high" },
  { id: "max", name: "Maximum — highest quality and latency" },
];

interface BolovanSettings {
  model: string;
  thinkingEffort: ThinkingEffort;
  baseUrl: string;
  brainFolder: string;
  deviceId: string;
  activeBranch?: string;
  includeActiveNote: boolean;
}

const DEFAULT_SETTINGS: BolovanSettings = {
  model: "gpt-5.6-terra",
  thinkingEffort: "medium",
  baseUrl: "https://api.openai.com/v1",
  brainFolder: "system/Bolovan",
  deviceId: "",
  includeActiveNote: true,
};

export default class BolovanPlugin extends Plugin {
  private agentInternal: BolovanAgent | undefined;
  private bolovanSettings: BolovanSettings = { ...DEFAULT_SETTINGS };
  private lastOpenedNote: TFile | undefined;

  async onload(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<BolovanSettings> | undefined;
    this.bolovanSettings = { ...DEFAULT_SETTINGS, ...knownSettings(loaded) };
    if (!this.bolovanSettings.deviceId) {
      this.bolovanSettings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }

    this.agentInternal = BolovanAgent.create({
      app: this.app,
      brainFolder: this.bolovanSettings.brainFolder,
      deviceId: this.bolovanSettings.deviceId,
      activeBranch: this.bolovanSettings.activeBranch,
      provider: () => this.providerConfig(),
      requestTransport: (request) => requestUrl(request),
      onActiveBranch: (path) => {
        this.bolovanSettings.activeBranch = path || undefined;
        void this.saveSettings();
      },
      onBrainFolder: (folder) => {
        if (folder !== this.bolovanSettings.brainFolder) {
          this.bolovanSettings.brainFolder = folder;
          void this.saveSettings();
        }
      },
    });

    this.registerView(BOLOVAN_CHAT_VIEW, (leaf) => new BolovanChatView(leaf, this));
    this.addRibbonIcon("message-square", "Open Bolovan chat", () => void this.toggleChatView());
    this.addCommand({ id: "open-chat", name: "Open Bolovan chat", callback: () => void this.toggleChatView() });
    this.addCommand({ id: "open-chat-tab", name: "Open Bolovan chat in new tab", callback: () => void this.openChatTab() });
    this.addCommand({
      id: "summarize-active-note",
      name: "Summarize active note with Bolovan",
      checkCallback: (checking) => {
        const activeNote = this.app.workspace.getActiveFile();
        if (!activeNote || activeNote.extension !== "md") {
          return false;
        }
        if (!checking) {
          void this.summarize(activeNote);
        }
        return true;
      },
    });
    this.addCommand({
      id: "stop-agent",
      name: "Stop current agent run",
      checkCallback: (checking) => {
        const isRunning = this.agentInternal?.status().isRunning ?? false;
        if (isRunning && !checking) {
          void this.agentInternal?.cancel();
        }
        return isRunning;
      },
    });
    this.addCommand({
      id: "new-conversation",
      name: "Start a new Bolovan conversation",
      callback: () => void this.startNewConversation(),
    });
    this.addSettingTab(new BolovanSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (file && file.extension === "md") {
        this.lastOpenedNote = file;
      }
    }));
  }

  onunload(): void {
    this.agentInternal?.dispose();
    this.agentInternal = undefined;
  }

  get agent(): BolovanAgent | undefined {
    return this.agentInternal;
  }

  get config(): Readonly<BolovanSettings> {
    return this.bolovanSettings;
  }

  get includeActiveNote(): boolean {
    return this.bolovanSettings.includeActiveNote;
  }

  async setIncludeActiveNote(include: boolean): Promise<void> {
    this.bolovanSettings.includeActiveNote = include;
    await this.saveSettings();
  }

  async setModel(model: string): Promise<void> {
    this.bolovanSettings.model = model.trim();
    await this.saveSettings();
  }

  async setThinkingEffort(effort: ThinkingEffort): Promise<void> {
    this.bolovanSettings.thinkingEffort = effort;
    await this.saveSettings();
  }

  async setBaseUrl(baseUrl: string): Promise<void> {
    this.bolovanSettings.baseUrl = baseUrl.trim();
    await this.saveSettings();
  }

  async setBrainFolder(folder: string): Promise<void> {
    const value = folder.trim().replace(/^\/+|\/+$/g, "");
    if (!value || value.startsWith(".") || value.includes("..")) {
      throw new Error("Choose a visible folder inside the vault");
    }
    this.bolovanSettings.brainFolder = value;
    await this.saveSettings();
    new Notice("Reload Bolovan to use the new brain folder");
  }

  hasApiKey(): boolean {
    return Boolean(this.app.secretStorage.getSecret(API_KEY_SECRET));
  }

  setApiKey(apiKey: string): void {
    this.app.secretStorage.setSecret(API_KEY_SECRET, apiKey.trim());
  }

  activeNote(): TFile | undefined {
    const current = this.app.workspace.getActiveFile();
    if (current) {
      return current.extension === "md" ? current : undefined;
    }
    const candidate = this.lastOpenedNote;
    if (!candidate || !this.noteStillOpen(candidate)) {
      return undefined;
    }
    return candidate;
  }

  async startAgent(): Promise<void> {
    if (!this.agentInternal) {
      throw new Error("Bolovan is not ready");
    }
    await this.agentInternal.start();
  }

  stopAgent(): void {
    this.agentInternal?.stop();
  }

  async openChatView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(BOLOVAN_CHAT_VIEW)[0];
    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      throw new Error("No sidebar available for the Bolovan chat");
    }
    await leaf.setViewState({ type: BOLOVAN_CHAT_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private providerConfig(): ProviderConfig {
    return {
      model: this.bolovanSettings.model,
      baseUrl: this.bolovanSettings.baseUrl,
      apiKey: this.app.secretStorage.getSecret(API_KEY_SECRET) ?? undefined,
      thinkingEffort: this.bolovanSettings.thinkingEffort,
    };
  }

  private noteStillOpen(note: TFile): boolean {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .some((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === note.path);
  }

  private async openChatTab(): Promise<void> {
    this.app.workspace.getLeavesOfType(BOLOVAN_CHAT_VIEW)[0]?.detach();
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: BOLOVAN_CHAT_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async toggleChatView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(BOLOVAN_CHAT_VIEW)[0];
    const chatIsActive = this.app.workspace.getActiveViewOfType(BolovanChatView) !== null;
    if (existingLeaf && chatIsActive) {
      existingLeaf.detach();
      return;
    }
    await this.openChatView();
  }

  private async startNewConversation(): Promise<void> {
    try {
      await this.startAgent();
      await this.agentInternal?.newSession();
      new Notice("Bolovan starts a new conversation");
    } catch (error) {
      new Notice(`Bolovan failed: ${describeError(error)}`);
    }
  }

  private async summarize(note: TFile): Promise<void> {
    try {
      await this.openChatView();
      await this.startAgent();
      await this.agentInternal?.ask(`Read ${note.path} and summarize it in three concise bullets.`);
    } catch (error) {
      new Notice(`Bolovan failed: ${describeError(error)}`);
    }
  }

  private async saveSettings(): Promise<void> {
    await this.saveData(this.bolovanSettings);
  }
}

class BolovanSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: BolovanPlugin) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    return this.plugin.config[key as keyof BolovanSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (typeof value !== "string") {
      return;
    }
    // Every setter owns its validation and persistence; the tab only routes.
    switch (key) {
      case "model":
        await this.plugin.setModel(value);
        return;
      case "thinkingEffort":
        await this.plugin.setThinkingEffort(value as ThinkingEffort);
        return;
      case "baseUrl":
        await this.plugin.setBaseUrl(value);
        return;
      case "brainFolder":
        await this.plugin.setBrainFolder(value);
        return;
    }
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "API key",
        desc: "Stored in Obsidian SecretStorage on this device; never written into the vault or synced.",
        render: (setting) => {
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.setPlaceholder(this.plugin.hasApiKey() ? "Configured — enter to replace" : "sk-…");
            text.onChange((value) => {
              if (value.trim()) {
                this.plugin.setApiKey(value);
              }
            });
          });
          setting.addExtraButton((button) => button
            .setIcon("trash")
            .setTooltip("Clear the saved API key")
            .onClick(() => {
              this.plugin.setApiKey("");
              this.update();
            }));
        },
      },
      {
        name: "Base URL",
        desc: "The endpoint root ending in /v1. It must implement OpenAI Chat Completions and function tools.",
        control: {
          type: "text",
          key: "baseUrl",
          placeholder: "https://api.openai.com/v1",
        },
      },
      {
        name: "Model",
        desc: "Model ID exposed by the endpoint.",
        control: { type: "text", key: "model", placeholder: "model-name" },
      },
      {
        name: "Thinking effort",
        desc: "Sent as reasoning_effort when enabled. Choose None if your endpoint does not support it.",
        control: {
          type: "dropdown" as const,
          key: "thinkingEffort",
          options: Object.fromEntries(THINKING_LEVELS.map((level) => [level.id, level.name])),
        },
      },
      {
        name: "AI brain folder",
        desc: "Visible folder inside the vault containing portable instructions, skills, prompts, and conversation branches.",
        control: {
          type: "text",
          key: "brainFolder",
          placeholder: "system/Bolovan",
          validate: validBrainFolder,
        },
      },
    ];
  }
}


/** Inline mirror of setBrainFolder's validation; the setter stays authoritative. */
function validBrainFolder(folder: string): string | void {
  const value = folder.trim().replace(/^\/+|\/+$/g, "");
  if (!value || value.startsWith(".") || value.includes("..")) {
    return "Choose a visible folder inside the vault";
  }
}

function knownSettings(loaded: Partial<BolovanSettings> | undefined): Partial<BolovanSettings> {
  if (!loaded) {
    return {};
  }
  const result: Partial<BolovanSettings> = {};
  for (const key of ["model", "thinkingEffort", "baseUrl", "brainFolder", "deviceId", "activeBranch", "includeActiveNote"] as const) {
    if (loaded[key] !== undefined) {
      (result as any)[key] = loaded[key];
    }
  }
  return result;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
