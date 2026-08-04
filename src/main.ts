import {
  App,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { BOLOVAN_CHAT_VIEW, BolovanChatView } from "./chat-view";
import { BolovanAgent } from "./bolovan-agent";

interface BolovanSettings {
  piPath?: string;
  sessionFile?: string;
  includeActiveNote?: boolean;
  mentionChips?: boolean;
}

export default class BolovanPlugin extends Plugin {
  private agentInternal: BolovanAgent | undefined;
  private bolovanSettings: BolovanSettings = {};
  private lastOpenedNote: TFile | undefined;

  async onload(): Promise<void> {
    this.bolovanSettings = Object.assign({}, (await this.loadData()) as BolovanSettings | undefined);

    // One agent for the plugin's life. Settings it might need (pi path,
    // session lineage) are read lazily, so nothing here recreates it.
    this.agentInternal = BolovanAgent.create({
      cwd: this.vaultRoot(),
      piPath: () => this.bolovanSettings.piPath,
      sessionFile: this.bolovanSettings.sessionFile,
      onSessionFile: (sessionFile) => void this.persistSessionFile(sessionFile),
    });

    this.registerView(BOLOVAN_CHAT_VIEW, (leaf) => new BolovanChatView(leaf, this));

    this.addRibbonIcon("message-square", "Open Bolovan chat", () => {
      void this.toggleChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open Bolovan chat",
      callback: () => void this.toggleChatView(),
    });

    this.addCommand({
      id: "open-chat-tab",
      name: "Open Bolovan chat in new tab",
      callback: () => void this.openChatTab(),
    });

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

    // The chat attaches "the open note", but its own leaf is active while
    // the user types; remember the last note actually opened.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && file.extension === "md") {
          this.lastOpenedNote = file;
        }
      }),
    );
  }

  onunload(): void {
    this.agentInternal?.dispose();
    this.agentInternal = undefined;
  }

  get agent(): BolovanAgent | undefined {
    return this.agentInternal;
  }

  get piPath(): string | undefined {
    return this.bolovanSettings.piPath;
  }

  /** Whether outgoing chat messages attach the open note as context. */
  get includeActiveNote(): boolean {
    return this.bolovanSettings.includeActiveNote ?? true;
  }

  async setIncludeActiveNote(include: boolean): Promise<void> {
    this.bolovanSettings.includeActiveNote = include;
    await this.saveData(this.bolovanSettings);
  }

  /** Whether composer mentions render as chips or Obsidian-style links. */
  get mentionChips(): boolean {
    return this.bolovanSettings.mentionChips ?? true;
  }

  async setMentionChips(useChips: boolean): Promise<void> {
    this.bolovanSettings.mentionChips = useChips;
    await this.saveData(this.bolovanSettings);
  }

  /**
   * The note to attach as context: the file in the active leaf when it is
   * a note, otherwise the last note opened before the chat took focus —
   * but only while that note is still open in some tab; closing it drops
   * the attachment. Non-markdown files are never attached.
   */
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

  private noteStillOpen(note: TFile): boolean {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .some((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === note.path);
  }

  /** Start the pi process if needed. Idempotent. */
  async startAgent(): Promise<void> {
    if (!this.agentInternal) {
      throw new Error("Bolovan is not ready");
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
    this.bolovanSettings.piPath = piPath || undefined;
    await this.saveData(this.bolovanSettings);
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

  private async openChatTab(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(BOLOVAN_CHAT_VIEW)[0];
    existingLeaf?.detach();

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: BOLOVAN_CHAT_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async toggleChatView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(BOLOVAN_CHAT_VIEW)[0];
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
      new Notice("Bolovan starts a new conversation");
    } catch (error) {
      new Notice(`Bolovan failed: ${describeError(error)}`);
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
      new Notice(`Bolovan failed: ${describeError(error)}`);
    }
  }

  private vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Bolovan only runs on desktop file-system vaults");
    }
    return adapter.getBasePath();
  }

  private async persistSessionFile(sessionFile: string): Promise<void> {
    this.bolovanSettings.sessionFile = sessionFile || undefined;
    await this.saveData(this.bolovanSettings);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class BolovanSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: BolovanPlugin,
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
