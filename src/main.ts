import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { NazarAgent, type NazarEvent } from "./nazar-agent";

interface NazarSettings {
  piPath?: string;
  sessionFile?: string;
}

export default class NazarPlugin extends Plugin {
  private agent: NazarAgent | undefined;
  private nazarSettings: NazarSettings = {};

  async onload(): Promise<void> {
    this.nazarSettings = Object.assign({}, (await this.loadData()) as NazarSettings | undefined);
    this.agent = this.createAgent();

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
        const isRunning = this.agent?.status().isRunning ?? false;
        if (isRunning && !checking) {
          void this.agent?.cancel();
        }
        return isRunning;
      },
    });

    this.addCommand({
      id: "new-conversation",
      name: "Start a new Nazar conversation",
      callback: () => {
        this.agent?.resetSession();
        new Notice("Nazar will start a new conversation");
      },
    });

    this.addSettingTab(new NazarSettingTab(this.app, this));
  }

  onunload(): void {
    this.agent?.dispose();
    this.agent = undefined;
  }

  get piPath(): string | undefined {
    return this.nazarSettings.piPath;
  }

  async setPiPath(piPath: string): Promise<void> {
    this.nazarSettings.piPath = piPath || undefined;
    await this.saveData(this.nazarSettings);
    this.agent?.dispose();
    this.agent = this.createAgent();
  }

  private createAgent(): NazarAgent {
    return NazarAgent.create({
      cwd: this.vaultRoot(),
      piPath: this.nazarSettings.piPath,
      sessionFile: this.nazarSettings.sessionFile,
      onSessionFile: (sessionFile) => void this.persistSessionFile(sessionFile),
    });
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

  private async summarize(note: TFile): Promise<void> {
    if (!this.agent) {
      new Notice("Nazar is not ready");
      return;
    }

    const notice = new Notice("Nazar is thinking…", 0);
    let response = "";

    try {
      await this.agent.ask(
        `Read ${note.path} and summarize it in three concise bullets.`,
        (event) => {
          response = updateNotice(notice, response, event);
        },
      );
      notice.setMessage(response || "Nazar completed without a text response");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notice.setMessage(`Nazar failed: ${message}`);
    }
  }
}

function updateNotice(notice: Notice, response: string, event: NazarEvent): string {
  if (event.type === "tool-start") {
    notice.setMessage(`Nazar is using ${event.name}…`);
    return response;
  }

  if (event.type !== "text") {
    return response;
  }

  const nextResponse = response + event.delta;
  notice.setMessage(nextResponse.slice(-600));
  return nextResponse;
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
        "Absolute path to the pi executable. Leave empty to search PATH and the common pi install locations.",
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
