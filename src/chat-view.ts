import { Component, ItemView, MarkdownRenderer, Modal, WorkspaceLeaf } from "obsidian";
import type NazarPlugin from "./main";
import type { NazarEvent, NazarUiRequest } from "./nazar-agent";
import { Transcript, type TranscriptItem } from "./transcript";

export const NAZAR_CHAT_VIEW = "nazar-chat-view";

const RENDER_THROTTLE_MS = 120;

/**
 * Sidebar chat over the long-lived pi RPC process. The view is a thin
 * adapter over the Transcript: it paints items keyed by id and owns nothing
 * but DOM concerns — throttling, scrolling, and dialogs.
 */
export class NazarChatView extends ItemView {
  private readonly component = new Component();
  private readonly transcript = new Transcript();
  private readonly itemEls = new Map<string, HTMLElement>();
  private readonly assistantPaintScheduled = new Set<string>();
  private unsubscribeAgent: (() => void) | undefined;
  private unsubscribeTranscript: (() => void) | undefined;

  private transcriptEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private sessionSelectEl!: HTMLSelectElement;
  private modelSelectEl!: HTMLSelectElement;
  private thinkingSelectEl!: HTMLSelectElement;
  private statsEl!: HTMLElement;

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
    this.unsubscribeTranscript = this.transcript.subscribe((item) =>
      this.onTranscriptChange(item),
    );
    this.unsubscribeAgent = this.plugin.subscribeToAgent((event) => this.onAgentEvent(event));
    this.plugin.setAgentUiResponder((request) => this.showDialog(request));

    try {
      await this.plugin.startAgent();
      await Promise.all([
        this.populateModelControls(),
        this.populateSessionPicker(),
        this.loadTranscript(),
        this.refreshStats(),
      ]);
    } catch (error) {
      this.transcript.note(describeError(error));
    }
  }

  async onClose(): Promise<void> {
    this.plugin.setAgentUiResponder(undefined);
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = undefined;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = undefined;
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

  // ----- transcript adapter ----------------------------------------------

  private async loadTranscript(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }

    this.itemEls.clear();
    this.assistantPaintScheduled.clear();
    this.transcriptEl.empty();

    try {
      this.transcript.loadHistory(await agent.getMessages());
    } catch (error) {
      this.transcript.note(describeError(error));
    }
    this.setRunning(agent.status().isRunning);
    this.scrollToBottom(true);
  }

  private onTranscriptChange(item: TranscriptItem): void {
    const existing = this.itemEls.get(item.id);
    if (!existing) {
      this.itemEls.set(item.id, this.createItemEl(item));
      return;
    }

    // Growing assistant blocks repaint on a throttle; everything else is
    // cheap enough to paint immediately.
    if (item.kind === "assistant" && !item.finalized) {
      this.scheduleAssistantPaint(item.id);
      return;
    }
    this.paintItem(item, existing);
  }

  private createItemEl(item: TranscriptItem): HTMLElement {
    let el: HTMLElement;
    if (item.kind === "tool") {
      el = this.transcriptEl.createDiv({ cls: "nazar-tool" });
      el.createSpan({ cls: "nazar-tool__status" });
      el.createSpan({ cls: "nazar-tool__label" });
    } else {
      el = this.transcriptEl.createDiv({ cls: `nazar-message nazar-message--${item.kind}` });
    }
    this.paintItem(item, el);
    this.scrollToBottom(true);
    return el;
  }

  private paintItem(item: TranscriptItem, el: HTMLElement): void {
    if (item.kind === "assistant") {
      this.assistantPaintScheduled.delete(item.id);
      el.empty();
      void MarkdownRenderer.render(this.app, item.markdown || "…", el, "", this.component);
      this.scrollToBottom(false);
      return;
    }

    if (item.kind === "tool") {
      const status = el.querySelector(".nazar-tool__status") as HTMLElement | null;
      const label = el.querySelector(".nazar-tool__label") as HTMLElement | null;
      status?.setText(item.status === "running" ? "…" : item.status === "done" ? "✓" : "✗");
      label?.setText(item.target ? `${item.name} · ${item.target.slice(0, 80)}` : item.name);
      el.toggleClass("nazar-tool--done", item.status === "done");
      el.toggleClass("nazar-tool--error", item.status === "error");
      return;
    }

    el.setText(item.text);
  }

  private scheduleAssistantPaint(id: string): void {
    if (this.assistantPaintScheduled.has(id)) {
      return;
    }
    this.assistantPaintScheduled.add(id);

    setTimeout(() => {
      this.assistantPaintScheduled.delete(id);
      const item = this.transcript.get(id);
      const el = this.itemEls.get(id);
      if (!item || !el || item.kind !== "assistant" || item.finalized) {
        return;
      }
      el.empty();
      void MarkdownRenderer.render(this.app, item.markdown || "…", el, "", this.component);
      this.scrollToBottom(false);
    }, RENDER_THROTTLE_MS);
  }

  // ----- agent events ------------------------------------------------------

  private onAgentEvent(event: NazarEvent): void {
    // Dialog requests travel through the ui responder, not the transcript.
    if (event.type === "ui-request") {
      return;
    }

    if (event.type === "settled") {
      this.transcript.apply(event);
      this.setRunning(false);
      this.scrollToBottom(true);
      // Runs can also be triggered from outside the view (plugin commands);
      // settled is the one signal that covers both.
      void this.refreshStats().catch(() => undefined);
      void this.populateSessionPicker().catch(() => undefined);
      return;
    }

    if (event.type === "exited") {
      this.transcript.apply(event);
      this.setRunning(false);
      return;
    }

    if (event.type === "text") {
      this.setRunning(true);
    }
    this.transcript.apply(event);
  }

  private setRunning(running: boolean): void {
    this.sendButtonEl.setText(running ? "Stop" : "Send");
  }

  // ----- composer ----------------------------------------------------------

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) {
      return;
    }
    this.inputEl.value = "";
    this.transcript.say(text);
    this.scrollToBottom(true);

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
      this.transcript.note(describeError(error));
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

  /** Extension dialog surface: approval gates, prompts, selections. */
  private showDialog(request: NazarUiRequest): void {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }
    new NazarDialogModal(this.app, request, (payload) => {
      agent.respondUi(request.id, payload);
    }).open();
  }

  // ----- controls ----------------------------------------------------------

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
      this.transcript.note(describeError(error));
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
      this.transcript.note(describeError(error));
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
      await Promise.all([this.loadTranscript(), this.refreshStats(), this.populateModelControls()]);
    } catch (error) {
      this.transcript.note(describeError(error));
    }
  }

  private async startNewSession(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }
    try {
      await agent.newSession();
      await Promise.all([this.loadTranscript(), this.populateSessionPicker(), this.refreshStats()]);
      this.inputEl.focus();
    } catch (error) {
      this.transcript.note(describeError(error));
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

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Obsidian dialog answering a pi extension UI request. Esc or close counts
 * as cancellation, which extensions receive as a declined dialog.
 */
class NazarDialogModal extends Modal {
  constructor(
    app: any,
    private readonly request: NazarUiRequest,
    private readonly respond: (payload: Record<string, unknown>) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.request.title ?? "Nazar");

    if (this.request.message) {
      this.contentEl.createEl("pre", {
        cls: "nazar-dialog__message",
        text: this.request.message,
      });
    }

    if (this.request.method === "confirm") {
      this.buildConfirm();
    } else if (this.request.method === "select") {
      this.buildSelect();
    } else {
      this.buildTextInput();
    }
  }

  onClose(): void {
    // The modal can close after a button already answered; answering twice
    // is harmless because pi ignores responses for settled requests.
    this.respond({ cancelled: true });
  }

  private answer(payload: Record<string, unknown>): void {
    this.respond(payload);
    this.close();
  }

  private buildConfirm(): void {
    const actions = this.contentEl.createDiv({ cls: "nazar-dialog__actions" });
    const reject = actions.createEl("button", { text: "Reject" });
    reject.addEventListener("click", () => this.answer({ confirmed: false }));
    const approve = actions.createEl("button", { cls: "mod-cta", text: "Approve" });
    approve.addEventListener("click", () => this.answer({ confirmed: true }));
    approve.focus();
  }

  private buildSelect(): void {
    const select = this.contentEl.createEl("select");
    for (const option of this.request.options ?? []) {
      select.createEl("option", { value: option, text: option });
    }

    const actions = this.contentEl.createDiv({ cls: "nazar-dialog__actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.answer({ cancelled: true }));
    const ok = actions.createEl("button", { cls: "mod-cta", text: "OK" });
    ok.addEventListener("click", () => this.answer({ value: select.value }));
    ok.focus();
  }

  private buildTextInput(): void {
    const textarea = this.contentEl.createEl("textarea", {
      cls: "nazar-dialog__text",
      attr: { placeholder: this.request.placeholder ?? "" },
      text: this.request.prefill ?? "",
    });

    const actions = this.contentEl.createDiv({ cls: "nazar-dialog__actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.answer({ cancelled: true }));
    const ok = actions.createEl("button", { cls: "mod-cta", text: "OK" });
    ok.addEventListener("click", () => this.answer({ value: textarea.value }));
    textarea.focus();
  }
}
