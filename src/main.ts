import { Notice, normalizePath, Plugin, TFile } from "obsidian";
import { NazarAgent, type NazarEvent } from "./nazar-agent";

const LOCAL_MODEL_URL = "http://127.0.0.1:8080/v1";
const LOCAL_MODEL_ID = "nazar-local";

export default class NazarPlugin extends Plugin {
  private agent: NazarAgent | undefined;

  async onload(): Promise<void> {
    this.agent = await NazarAgent.create({
      baseUrl: LOCAL_MODEL_URL,
      modelId: LOCAL_MODEL_ID,
      readNote: (path) => this.readVisibleMarkdown(path),
    });

    this.addCommand({
      id: "summarize-active-note",
      name: "Summarize active note with local agent",
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
  }

  onunload(): void {
    this.agent?.dispose();
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

  private async readVisibleMarkdown(path: string): Promise<string> {
    const normalizedPath = normalizePath(path);
    const note = this.app.vault.getAbstractFileByPath(normalizedPath);
    const isVisibleMarkdown = note instanceof TFile && note.extension === "md";
    if (!isVisibleMarkdown) {
      throw new Error("The requested path is not a visible Markdown note");
    }

    return this.app.vault.cachedRead(note);
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
