import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type NazarPlugin from "./main";
import type { NazarEvent } from "./nazar-agent";

export const NAZAR_CHAT_VIEW = "nazar-chat-view";

const RENDER_THROTTLE_MS = 120;

/**
 * Sidebar chat over the long-lived pi RPC process. The process lifecycle is
 * the view lifecycle: it starts when the view opens and dies when it closes.
 */
export class NazarChatView extends ItemView {
  private readonly component = new Component();
  private unsubscribe: (() => void) | undefined;

  private transcriptEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private sessionSelectEl!: HTMLSelectElement;
  private modelSelectEl!: HTMLSelectElement;
  private thinkingSelectEl!: HTMLSelectElement;
  private statsEl!: HTMLElement;

  private streamBuffer = "";
  private streamEl: HTMLElement | undefined;
  private renderScheduled = false;
  private openToolLines = new Map<string, HTMLElement[]>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: NazarPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return NAZAR_CHAT_VIEW;
  }

  getDisplayText(): string {
    return "Nazar chat";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.component.load();
    this.buildLayout();
    this.unsubscribe = this.plugin.subscribeToAgent((event) => this.onAgentEvent(event));

    try {
      await this.plugin.startAgent();
      await Promise.all([
        this.populateModelControls(),
        this.populateSessionPicker(),
        this.reloadTranscript(),
        this.refreshStats(),
      ]);
    } catch (error) {
      this.appendSystem(describeError(error));
    }
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.component.unload();
    this.plugin.stopAgent();
  }

  /** External entry point for plugin commands (e.g. summarize active note). */
  focusComposer(): void {
    this.inputEl?.focus();
  }

  private buildLayout(): void {
    const root = this.contentEl.createDiv({ cls: "nazar-panel" });

    const header = root.createDiv({ cls: "nazar-panel__header" });
    this.sessionSelectEl = header.createEl("select", { cls: "nazar-chat__sessions" });
    const newSessionButton = header.createEl("button", {
      cls: "nazar-chat__new",
      attr: { "aria-label": "New Nazar conversation" },
    });
    newSessionButton.innerHTML = "+";
    newSessionButton.addEventListener("click", () => void this.startNewSession());
    this.sessionSelectEl.addEventListener("change", () => void this.switchToSelectedSession());

    const controls = root.createDiv({ cls: "nazar-chat__controls" });
    this.modelSelectEl = controls.createEl("select", { cls: "nazar-chat__models" });
    this.thinkingSelectEl = controls.createEl("select", { cls: "nazar-chat__thinking" });
    this.statsEl = controls.createSpan({ cls: "nazar-chat__stats" });
    this.modelSelectEl.addEventListener("change", () => void this.applyModelSelection());
    this.thinkingSelectEl.addEventListener("change", () => void this.applyThinkingSelection());

    this.transcriptEl = root.createDiv({ cls: "nazar-panel__transcript" });

    const composer = root.createDiv({ cls: "nazar-panel__composer" });
    this.inputEl = composer.createEl("textarea", {
      attr: { placeholder: "Ask Nazar… (Enter to send, Shift+Enter for a new line)" },
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.send();
      }
    });

    const actions = composer.createDiv({ cls: "nazar-panel__actions" });
    this.sendButtonEl = actions.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendButtonEl.addEventListener("click", () => void this.onSendButton());
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) {
      return;
    }
    this.inputEl.value = "";
    this.appendUser(text);

    try {
      await this.plugin.startAgent();
      const agent = this.plugin.agent;
      if (!agent) {
        throw new Error("Nazar is not ready");
      }

      if (agent.status().isRunning) {
        await agent.steer(text);
      } else {
        await agent.ask(text);
      }
    } catch (error) {
      this.appendSystem(describeError(error));
    }
  }

  private async onSendButton(): Promise<void> {
    const agent = this.plugin.agent;
    if (agent?.status().isRunning) {
      await agent.cancel();
      return;
    }
    await this.send();
  }

  private onAgentEvent(event: NazarEvent): void {
    if (event.type === "text") {
      this.appendStreamText(event.delta);
      return;
    }

    if (event.type === "tool-start") {
      this.finalizeStream();
      this.appendToolLine(event.name, event.args);
      return;
    }

    if (event.type === "tool-end") {
      this.markToolLine(event.name, event.isError);
      return;
    }

    if (event.type === "settled") {
      this.finalizeStream();
      this.setRunning(false);
      this.scrollToBottom(true);
      // Runs can also be triggered from outside the view (plugin commands);
      // settled is the one signal that covers both.
      void this.refreshStats().catch(() => undefined);
      void this.populateSessionPicker().catch(() => undefined);
      return;
    }

    if (event.type === "exited") {
      this.finalizeStream();
      this.setRunning(false);
      this.appendSystem(`${event.message} Send a message to restart.`);
    }
  }

  private setRunning(running: boolean): void {
    this.sendButtonEl.setText(running ? "Stop" : "Send");
  }

  private appendUser(text: string): void {
    this.finalizeStream();
    this.transcriptEl.createDiv({ cls: "nazar-message nazar-message--user", text });
    this.scrollToBottom(true);
  }

  private appendSystem(text: string): void {
    this.finalizeStream();
    this.transcriptEl.createDiv({ cls: "nazar-message nazar-message--system", text });
    this.scrollToBottom(true);
  }

  private appendStreamText(delta: string): void {
    if (!this.streamEl) {
      this.streamEl = this.transcriptEl.createDiv({
        cls: "nazar-message nazar-message--assistant",
      });
    }
    this.streamBuffer += delta;
    this.setRunning(true);
    this.scheduleStreamRender();
  }

  private scheduleStreamRender(): void {
    if (this.renderScheduled || !this.streamEl) {
      return;
    }
    this.renderScheduled = true;
    const target = this.streamEl;
    setTimeout(() => {
      this.renderScheduled = false;
      void this.renderMarkdown(this.streamBuffer, target);
    }, RENDER_THROTTLE_MS);
  }

  private finalizeStream(): void {
    if (!this.streamEl) {
      return;
    }
    const target = this.streamEl;
    const markdown = this.streamBuffer;
    this.streamEl = undefined;
    this.streamBuffer = "";
    this.renderScheduled = false;
    void this.renderMarkdown(markdown, target);
    this.scrollToBottom(false);
  }

  private async renderMarkdown(markdown: string, target: HTMLElement): Promise<void> {
    target.empty();
    await MarkdownRenderer.render(this.app, markdown || "…", target, "", this.component);
    this.scrollToBottom(false);
  }

  private appendToolLine(name: string, args: Record<string, unknown>): void {
    const line = this.transcriptEl.createDiv({ cls: "nazar-tool" });
    line.createSpan({ cls: "nazar-tool__status", text: "…" });
    line.createSpan({ cls: "nazar-tool__label", text: describeToolCall(name, args) });
    const stack = this.openToolLines.get(name) ?? [];
    stack.push(line);
    this.openToolLines.set(name, stack);
    this.scrollToBottom(false);
  }

  private markToolLine(name: string, isError: boolean): void {
    const stack = this.openToolLines.get(name);
    const line = stack?.pop();
    if (!line) {
      return;
    }
    line.querySelector(".nazar-tool__status")?.setText(isError ? "✗" : "✓");
    line.addClass(isError ? "nazar-tool--error" : "nazar-tool--done");
  }

  private async reloadTranscript(): Promise<void> {
    this.transcriptEl.empty();
    this.streamEl = undefined;
    this.streamBuffer = "";
    this.openToolLines.clear();

    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }

    let messages: any[] = [];
    try {
      messages = await agent.getMessages();
    } catch (error) {
      this.appendSystem(describeError(error));
      return;
    }

    for (const message of messages) {
      this.renderHistoryMessage(message);
    }
    this.setRunning(agent.status().isRunning);
    this.scrollToBottom(true);
  }

  private renderHistoryMessage(message: any): void {
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : extractText(message.content);
      if (message.attachments?.length) {
        return; // Bash/context attachments are noise in the transcript.
      }
      this.transcriptEl.createDiv({ cls: "nazar-message nazar-message--user", text });
      return;
    }

    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          const el = this.transcriptEl.createDiv({ cls: "nazar-message nazar-message--assistant" });
          void this.renderMarkdown(block.text, el);
        }
        if (block.type === "toolCall") {
          const line = this.transcriptEl.createDiv({ cls: "nazar-tool nazar-tool--done" });
          line.createSpan({ cls: "nazar-tool__status", text: "✓" });
          line.createSpan({
            cls: "nazar-tool__label",
            text: describeToolCall(block.name ?? "tool", parseJson(block.arguments)),
          });
        }
      }
      return;
    }

    if (message.role === "toolResult" && message.isError) {
      const text = extractText(message.content).slice(0, 400);
      this.transcriptEl.createDiv({
        cls: "nazar-message nazar-message--system",
        text: `${message.toolName ?? "tool"} failed: ${text}`,
      });
    }
  }

  private async populateModelControls(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }

    const [state, models, levels] = await Promise.all([
      agent.getState(),
      agent.listModels(),
      agent.listThinkingLevels(),
    ]);

    this.modelSelectEl.empty();
    for (const model of models) {
      this.modelSelectEl.createEl("option", {
        value: `${model.provider}/${model.id}`,
        text: model.name,
      });
    }
    this.modelSelectEl.value = `${state.provider}/${state.modelId}`;

    this.thinkingSelectEl.empty();
    for (const level of levels) {
      this.thinkingSelectEl.createEl("option", { value: level, text: level });
    }
    this.thinkingSelectEl.value = state.thinkingLevel;
  }

  private async applyModelSelection(): Promise<void> {
    const agent = this.plugin.agent;
    const [provider, modelId] = this.modelSelectEl.value.split("/");
    if (!agent || !provider || !modelId) {
      return;
    }
    try {
      await agent.setModel(provider, modelId);
      await Promise.all([this.populateModelControls(), this.refreshStats()]);
    } catch (error) {
      this.appendSystem(describeError(error));
    }
  }

  private async applyThinkingSelection(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }
    try {
      await agent.setThinkingLevel(this.thinkingSelectEl.value);
    } catch (error) {
      this.appendSystem(describeError(error));
    }
  }

  private async populateSessionPicker(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }

    const sessions = agent.listSessions();
    const current = agent.status().sessionFile;

    this.sessionSelectEl.empty();
    for (const session of sessions) {
      this.sessionSelectEl.createEl("option", {
        value: session.path,
        text: session.label,
      });
    }
    if (current && !sessions.some((session) => session.path === current)) {
      this.sessionSelectEl.createEl("option", { value: current, text: "current session" });
    }
    if (current) {
      this.sessionSelectEl.value = current;
    }
  }

  private async switchToSelectedSession(): Promise<void> {
    const agent = this.plugin.agent;
    const target = this.sessionSelectEl.value;
    if (!agent || !target || target === agent.status().sessionFile) {
      return;
    }
    try {
      await agent.switchSession(target);
      await Promise.all([this.reloadTranscript(), this.refreshStats(), this.populateModelControls()]);
    } catch (error) {
      this.appendSystem(describeError(error));
    }
  }

  private async startNewSession(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }
    try {
      await agent.newSession();
      await Promise.all([this.reloadTranscript(), this.populateSessionPicker(), this.refreshStats()]);
      this.inputEl.focus();
    } catch (error) {
      this.appendSystem(describeError(error));
    }
  }

  private async refreshStats(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }
    try {
      const stats = await agent.getStats();
      const tokens = stats.tokens?.total ?? 0;
      const cost = stats.cost ?? 0;
      const context = stats.contextUsage?.percent;
      const contextPart = typeof context === "number" ? ` · ${context}% context` : "";
      this.statsEl.setText(`${formatTokens(tokens)} tokens · $${cost.toFixed(3)}${contextPart}`);
    } catch {
      this.statsEl.setText("");
    }
  }

  private scrollToBottom(force: boolean): void {
    const el = this.transcriptEl;
    if (!el) {
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (force || nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }
}

function describeToolCall(name: string, args: Record<string, unknown> | undefined): string {
  const target = args?.path ?? args?.command ?? args?.pattern ?? "";
  const short = String(target).slice(0, 80);
  return short ? `${name} · ${short}` : name;
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return value as Record<string, unknown> | undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
