import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { NAZAR_CHAT_VIEW, NazarChatView } from "./chat-view";
import { NazarAgent } from "./nazar-agent";

interface NazarSettings {
  piPath?: string;
  sessionFile?: string;
}

export default class NazarPlugin extends Plugin {
  private agentInternal: NazarAgent | undefined;
  private nazarSettings: NazarSettings = {};

  async onload(): Promise<void> {
    this.nazarSettings = Object.assign({}, (await this.loadData()) as NazarSettings | undefined);

    // One agent for the plugin's life. Settings it might need (pi path,
    // session lineage) are read lazily, so nothing here recreates it.
    this.agentInternal = NazarAgent.create({
      cwd: this.vaultRoot(),
      piPath: () => this.nazarSettings.piPath,
      sessionFile: this.nazarSettings.sessionFile,
      onSessionFile: (sessionFile) => void this.persistSessionFile(sessionFile),
    });

    this.registerView(NAZAR_CHAT_VIEW, (leaf) => new NazarChatView(leaf, this));

    this.addRibbonIcon("message-square", "Open Nazar chat", () => {
      void this.toggleChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open Nazar chat",
      callback: () => void this.toggleChatView(),
    });

    this.addCommand({
      id: "summarize-active-note",
      name: "Summarize active note with Nazar",
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
      name: "Start a new Nazar conversation",
      callback: () => void this.startNewConversation(),
    });

    this.addSettingTab(new NazarSettingTab(this.app, this));
  }

  onunload(): void {
    this.agentInternal?.dispose();
    this.agentInternal = undefined;
  }

  get agent(): NazarAgent | undefined {
    return this.agentInternal;
  }

  get piPath(): string | undefined {
    return this.nazarSettings.piPath;
  }

  /** Start the pi process if needed. Idempotent. */
  async startAgent(): Promise<void> {
    if (!this.agentInternal) {
      throw new Error("Nazar is not ready");
    }
    if (!this.agentInternal.started()) {
      await this.agentInternal.start();
    }
  }

  /** Kill the pi process; the agent can start a new one later. */
  stopAgent(): void {
    this.agentInternal?.stop();
  }

  /** Saved only; a changed path applies the next time pi starts. */
  async setPiPath(piPath: string): Promise<void> {
    this.nazarSettings.piPath = piPath || undefined;
    await this.saveData(this.nazarSettings);
  }

  async openChatView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(NAZAR_CHAT_VIEW)[0];
    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      throw new Error("No sidebar available for the Nazar chat");
    }
    await leaf.setViewState({ type: NAZAR_CHAT_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async toggleChatView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(NAZAR_CHAT_VIEW)[0];
    if (existingLeaf && this.app.workspace.activeLeaf === existingLeaf) {
      existingLeaf.detach();
      return;
    }
    await this.openChatView();
  }

  private async startNewConversation(): Promise<void> {
    const agent = this.agentInternal;
    if (!agent) {
      return;
    }
    try {
      if (agent.started()) {
        await agent.newSession();
      } else {
        agent.resetSession();
      }
      new Notice("Nazar starts a new conversation");
    } catch (error) {
      new Notice(`Nazar failed: ${describeError(error)}`);
    }
  }

  private async summarize(note: TFile): Promise<void> {
    try {
      await this.openChatView();
      await this.startAgent();
      await this.agentInternal?.ask(
        `Read ${note.path} and summarize it in three concise bullets.`,
      );
    } catch (error) {
      new Notice(`Nazar failed: ${describeError(error)}`);
    }
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Nazar only runs on desktop file-system vaults");
    }
    return adapter.getBasePath();
  }

  private async persistSessionFile(sessionFile: string): Promise<void> {
    this.nazarSettings.sessionFile = sessionFile || undefined;
    await this.saveData(this.nazarSettings);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class NazarSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: NazarPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName("pi binary path")
      .setDesc(
        "Absolute path to the pi executable. Leave empty to search PATH and the common pi install locations. Applies the next time pi starts.",
      )
      .addText((text) => {
        text
          .setPlaceholder("pi (on PATH)")
          .setValue(this.plugin.piPath ?? "")
          .onChange(async (value) => {
            await this.plugin.setPiPath(value.trim());
          });
      });
  }
}
