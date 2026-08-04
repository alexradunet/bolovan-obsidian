import { App, Component, FuzzySuggestModal, ItemView, MarkdownRenderer, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type BolovanPlugin from "./main";
import type { BolovanEvent, BolovanUiRequest } from "./bolovan-agent";
import { Composer } from "./composer";
import {
  buildPromptWithNotes,
  MAX_ATTACHMENTS,
  mentionLabel,
  parseMentionLinkpaths,
  type NoteAttachment,
  type NoteCandidate,
} from "./context";
import { Transcript, type TranscriptItem } from "./transcript";

export const BOLOVAN_CHAT_VIEW = "bolovan-chat-view";

const RENDER_THROTTLE_MS = 120;
const THINKING_MARKDOWN = "*Thinking…*";

/**
 * Sidebar chat over the long-lived pi RPC process. The view is a thin
 * adapter over the Transcript: it paints items keyed by id and owns nothing
 * but DOM concerns — throttling, scrolling, and dialogs.
 */
export class BolovanChatView extends ItemView {
  private readonly component = new Component();
  private readonly transcript = new Transcript();
  private readonly itemEls = new Map<string, HTMLElement>();
  private readonly assistantPaintScheduled = new Set<string>();
  private unsubscribeAgent: (() => void) | undefined;
  private unsubscribeTranscript: (() => void) | undefined;

  private rootEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private jumpButtonEl!: HTMLButtonElement;
  private contextRowEl!: HTMLElement;
  private composer!: Composer;
  private sendButtonEl!: HTMLButtonElement;
  private activeNoteToggleEl!: HTMLButtonElement;
  private newSessionButtonEl!: HTMLButtonElement;
  private sessionSelectEl!: HTMLSelectElement;
  private modelSelectEl!: HTMLSelectElement;
  private thinkingSelectEl!: HTMLSelectElement;
  private statusEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private pinnedToBottom = true;
  private hasRunActivity = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: BolovanPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return BOLOVAN_CHAT_VIEW;
  }

  getDisplayText(): string {
    return "Bolovan chat";
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
    // The agent lives for the plugin's lifetime, so the view attaches to it
    // directly; nothing swaps it out from under us.
    const agent = this.plugin.agent;
    if (agent) {
      this.unsubscribeAgent = agent.subscribe((event) => this.onAgentEvent(event));
      agent.setUiResponder((request) => this.showDialog(request));
    }

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

    // The context row reflects the note behind the chat; keep it current.
    this.updateContextRow();
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateContextRow()));
    // Closing a note tab must drop it from the context line.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.updateContextRow()));
  }

  async onClose(): Promise<void> {
    this.plugin.agent?.setUiResponder(undefined);
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = undefined;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = undefined;
    this.component.unload();
    this.plugin.stopAgent();
  }

  /** External entry point for plugin commands (e.g. summarize active note). */
  focusComposer(): void {
    this.composer.focus();
  }

  private buildLayout(): void {
    this.contentEl.empty();
    this.rootEl = this.contentEl.createDiv({ cls: "bolovan-panel" });

    const header = this.rootEl.createDiv({ cls: "bolovan-panel__header" });
    const sessionGroup = header.createDiv({ cls: "bolovan-chat__session-group" });
    this.newSessionButtonEl = sessionGroup.createEl("button", {
      cls: "clickable-icon bolovan-chat__new",
      attr: { "aria-label": "New conversation", title: "New conversation" },
    });
    setIcon(this.newSessionButtonEl, "square-pen");
    this.newSessionButtonEl.addEventListener("click", () => void this.startNewSession());

    this.sessionSelectEl = sessionGroup.createEl("select", {
      cls: "bolovan-chat__sessions",
      attr: { "aria-label": "Conversation" },
    });
    this.sessionSelectEl.addEventListener("change", () => void this.switchToSelectedSession());

    const transcriptStage = this.rootEl.createDiv({ cls: "bolovan-panel__transcript-stage" });
    this.transcriptEl = transcriptStage.createDiv({
      cls: "bolovan-panel__transcript",
      attr: { role: "log", "aria-live": "polite", "aria-label": "Conversation" },
    });
    this.transcriptEl.addEventListener("scroll", () => this.onTranscriptScroll());
    this.transcriptEl.addEventListener("click", (event) => this.onTranscriptClick(event));
    this.buildEmptyState();
    this.buildStatus();

    this.jumpButtonEl = transcriptStage.createEl("button", {
      cls: "bolovan-chat__jump clickable-icon",
      attr: { "aria-label": "Jump to latest message", title: "Jump to latest" },
    });
    setIcon(this.jumpButtonEl, "arrow-down");
    this.jumpButtonEl.addEventListener("click", () => this.scrollToBottom(true));

    const composerStage = this.rootEl.createDiv({ cls: "bolovan-panel__composer-stage" });
    const composer = composerStage.createDiv({ cls: "bolovan-panel__composer" });
    this.contextRowEl = composer.createDiv({ cls: "bolovan-chat__context" });
    this.composer = new Composer({
      editorHost: composer,
      pickerHost: composerStage,
      getNotes: () => this.noteCandidates(),
      onSend: () => void this.send(),
    });

    const controls = composer.createDiv({ cls: "bolovan-chat__controls" });
    const attachNoteButtonEl = controls.createEl("button", {
      cls: "clickable-icon bolovan-chat__pick-note",
      attr: { "aria-label": "Attach note", title: "Attach note ([[)" },
    });
    setIcon(attachNoteButtonEl, "paperclip");
    attachNoteButtonEl.addEventListener("click", () => {
      new NoteAttachModal(this.app, (file) => {
        const label = mentionLabel(
          { path: file.path, basename: file.basename },
          this.noteCandidates(),
        );
        this.composer.insertMention(label);
      }).open();
    });

    this.activeNoteToggleEl = controls.createEl("button", {
      cls: "clickable-icon bolovan-chat__active-note-toggle",
    });
    setIcon(this.activeNoteToggleEl, "file-input");
    this.activeNoteToggleEl.addEventListener("click", () => {
      void this.toggleActiveNoteAttachment();
    });

    this.modelSelectEl = controls.createEl("select", {
      cls: "bolovan-chat__models",
      attr: { "aria-label": "Model", title: "Model" },
    });
    this.thinkingSelectEl = controls.createEl("select", {
      cls: "bolovan-chat__thinking",
      attr: { "aria-label": "Thinking effort", title: "Thinking effort" },
    });
    this.statsEl = controls.createSpan({ cls: "bolovan-chat__stats" });
    this.modelSelectEl.addEventListener("change", () => void this.applyModelSelection());
    this.thinkingSelectEl.addEventListener("change", () => void this.applyThinkingSelection());

    this.sendButtonEl = controls.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendButtonEl.addEventListener("click", () => void this.onSendButton());
  }

  private buildEmptyState(): void {
    this.emptyEl = this.transcriptEl.createDiv({ cls: "bolovan-chat__empty" });
    const mark = this.emptyEl.createDiv({ cls: "bolovan-chat__empty-mark" });
    setIcon(mark, "sparkles");
    this.emptyEl.createEl("h3", { text: "Work with your vault" });
    this.emptyEl.createEl("p", {
      text: "Ask questions, improve notes, or turn an idea into action.",
    });

    const suggestions = this.emptyEl.createDiv({ cls: "bolovan-chat__suggestions" });
    for (const prompt of [
      "Summarize my active note",
      "Help me organize my inbox",
      "Find connections between my notes",
    ]) {
      const button = suggestions.createEl("button", { text: prompt });
      button.addEventListener("click", () => {
        this.composer.setText(prompt);
        this.composer.focus();
      });
    }
  }

  private buildStatus(): void {
    this.statusEl = this.transcriptEl.createDiv({
      cls: "bolovan-chat__status",
      attr: { role: "status", "aria-live": "polite" },
      text: "Waiting for your input",
    });
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
    this.buildEmptyState();
    this.buildStatus();
    this.pinnedToBottom = true;

    try {
      this.transcript.loadHistory(await agent.getMessages());
    } catch (error) {
      this.transcript.note(describeError(error));
    }
    this.setRunning(agent.status().isRunning);
    this.updateEmptyState();
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
      el = this.transcriptEl.createDiv({ cls: "bolovan-tool" });
      el.createSpan({ cls: "bolovan-tool__status" });
      el.createSpan({ cls: "bolovan-tool__label" });
    } else {
      el = this.transcriptEl.createDiv({ cls: `bolovan-message bolovan-message--${item.kind}` });
    }
    this.transcriptEl.insertBefore(el, this.statusEl);
    this.updateEmptyState();
    this.paintItem(item, el);
    this.scrollToBottom(false);
    return el;
  }

  private paintItem(item: TranscriptItem, el: HTMLElement): void {
    if (item.kind === "assistant") {
      this.assistantPaintScheduled.delete(item.id);
      el.empty();
      // A thinking placeholder that never received text shows nothing.
      const silent = item.finalized && !item.markdown.trim();
      el.toggleClass("is-silent", silent);
      el.toggleClass("is-streaming", !item.finalized);
      if (silent) {
        return;
      }
      void MarkdownRenderer.render(this.app, item.markdown || THINKING_MARKDOWN, el, "", this.component)
        .then(() => this.scrollToBottom(false));
      return;
    }

    if (item.kind === "tool") {
      const status = el.querySelector(".bolovan-tool__status") as HTMLElement | null;
      const label = el.querySelector(".bolovan-tool__label") as HTMLElement | null;
      status?.setText(item.status === "running" ? "…" : item.status === "done" ? "✓" : "✗");
      if (label) {
        label.empty();
        label.createSpan({ text: item.name });
        if (item.target) {
          label.createSpan({ text: " · " });
          const targetText = item.target.slice(0, 80);
          // A tool target that is an existing note becomes a link that opens
          // it — created and edited files are one click away.
          const note = this.resolveNote(item.target);
          if (note) {
            label.createEl("a", {
              cls: "internal-link bolovan-tool__link",
              text: targetText,
              attr: { href: "#", "data-href": note.path },
            });
          } else {
            label.createSpan({ text: targetText });
          }
        }
      }
      el.toggleClass("bolovan-tool--done", item.status === "done");
      el.toggleClass("bolovan-tool--error", item.status === "error");
      return;
    }

    if (item.kind === "user") {
      el.empty();
      if (item.attachments?.length) {
        const attachments = el.createDiv({ cls: "bolovan-chat__attachments" });
        for (const path of item.attachments) {
          const link = attachments.createSpan({
            cls: "bolovan-chat__attachment",
            text: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
          });
          link.setAttr("title", path);
          link.addEventListener("click", () => void this.openAttachment(path));
        }
      }
      el.createDiv({ text: item.text });
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
      el.addClass("is-streaming");
      void MarkdownRenderer.render(this.app, item.markdown || THINKING_MARKDOWN, el, "", this.component)
        .then(() => this.scrollToBottom(false));
    }, RENDER_THROTTLE_MS);
  }

  // ----- agent events ------------------------------------------------------

  private onAgentEvent(event: BolovanEvent): void {
    // Dialog requests travel through the ui responder, not the transcript.
    if (event.type === "ui-request") {
      return;
    }

    if (event.type === "settled") {
      this.transcript.apply(event);
      this.hasRunActivity = false;
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
      this.hasRunActivity = false;
      this.setRunning(false);
      return;
    }

    if (event.type === "text" || event.type === "tool-start") {
      this.hasRunActivity = true;
      this.setRunning(true);
    }
    this.transcript.apply(event);
  }

  private setRunning(running: boolean): void {
    this.rootEl.toggleClass("is-running", running);
    this.sendButtonEl.setText(running ? "Stop" : "Send");
    this.sendButtonEl.setAttr("aria-label", running ? "Stop response" : "Send message");
    const runningText = this.hasRunActivity ? "Working…" : "Thinking…";
    this.statusEl.setText(running ? runningText : "Waiting for your input");
    this.sessionSelectEl.disabled = running;
    this.newSessionButtonEl.disabled = running;
  }

  // ----- composer ----------------------------------------------------------

  private async send(): Promise<void> {
    const text = this.composer.getText().trim();
    if (!text) {
      return;
    }
    this.composer.clear();

    const { notes, warnings } = await this.collectAttachedNotes(text);
    this.transcript.say(text, notes.map((note) => note.path));
    for (const warning of warnings) {
      this.transcript.note(warning);
    }

    // Live feedback from the moment of sending: the run state flips now,
    // not when the first token arrives, and a thinking placeholder opens in
    // the transcript.
    const alreadyRunning = this.plugin.agent?.status().isRunning ?? false;
    if (!alreadyRunning) {
      this.hasRunActivity = false;
      this.setRunning(true);
      this.transcript.runStarted();
    }
    this.scrollToBottom(true);

    try {
      await this.plugin.startAgent();
      const agent = this.plugin.agent;
      if (!agent) {
        throw new Error("Bolovan is not ready");
      }

      const prompt = buildPromptWithNotes(text, notes);
      if (agent.status().isRunning) {
        await agent.steer(prompt);
      } else {
        await agent.ask(prompt);
      }
    } catch (error) {
      this.transcript.note(describeError(error));
      this.setRunning(false);
    }
  }

  /**
   * Gather the note contents attached to an outgoing message: the active
   * note (when enabled) plus every resolvable [[mention]] in the text.
   * Unresolvable mentions are reported but never block the send.
   */
  private async collectAttachedNotes(
    text: string,
  ): Promise<{ notes: NoteAttachment[]; warnings: string[] }> {
    const notes: NoteAttachment[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    const attach = async (file: TFile): Promise<void> => {
      if (seen.has(file.path)) {
        return;
      }
      seen.add(file.path);
      if (notes.length >= MAX_ATTACHMENTS) {
        warnings.push(`Attachment limit reached; ${file.path} was not attached.`);
        return;
      }
      try {
        const content = await this.app.vault.cachedRead(file);
        notes.push({ path: file.path, content });
      } catch (error) {
        warnings.push(`Could not read ${file.path}: ${describeError(error)}`);
      }
    };

    if (this.plugin.includeActiveNote) {
      const activeNote = this.plugin.activeNote();
      if (activeNote) {
        await attach(activeNote);
      }
    }

    for (const linkpath of parseMentionLinkpaths(text)) {
      const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, "");
      if (!file) {
        warnings.push(`No note found for [[${linkpath}]] — sent without it.`);
        continue;
      }
      await attach(file);
    }

    return { notes, warnings };
  }

  /** All vault notes, newest first, as mention candidates. */
  private noteCandidates(): NoteCandidate[] {
    return [...this.app.vault.getMarkdownFiles()]
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .map((file) => ({ path: file.path, basename: file.basename }));
  }

  private async toggleActiveNoteAttachment(): Promise<void> {
    await this.plugin.setIncludeActiveNote(!this.plugin.includeActiveNote);
    this.updateContextRow();
  }

  /** Open a wikilink rendered in the transcript (e.g. in agent replies). */
  private onTranscriptClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const link = target.closest("a.internal-link");
    if (!(link instanceof HTMLElement)) {
      return;
    }
    event.preventDefault();
    const href = link.getAttr("data-href") ?? link.textContent ?? "";
    if (!href) {
      return;
    }
    const file = this.resolveNote(href);
    if (!file) {
      new Notice(`No note found for [[${href}]]`);
      return;
    }
    void this.openNote(file);
  }

  /** Resolve a full vault path or a wikilink to an existing note. */
  private resolveNote(href: string): TFile | undefined {
    const byPath = this.app.vault.getAbstractFileByPath(href);
    if (byPath instanceof TFile) {
      return byPath;
    }
    return this.app.metadataCache.getFirstLinkpathDest(href, "") ?? undefined;
  }

  /** Open an attached note from the transcript. */
  private async openAttachment(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`This note no longer exists: ${path}`);
      return;
    }
    await this.openNote(file);
  }

  /** Open a note without ever replacing the chat surface itself. */
  private async openNote(file: TFile): Promise<void> {
    try {
      const leaf =
        this.app.workspace.activeLeaf === this.leaf
          ? this.app.workspace.getLeaf("tab")
          : this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    } catch (error) {
      new Notice(`Could not open ${file.path}: ${describeError(error)}`);
    }
  }

  /** Show what travels with the next message: the active note, if enabled. */
  private updateContextRow(): void {
    this.contextRowEl.empty();

    const including = this.plugin.includeActiveNote;
    const activeNote = including ? this.plugin.activeNote() : undefined;
    this.activeNoteToggleEl.toggleClass("is-on", including);
    this.activeNoteToggleEl.setAttr(
      "aria-label",
      including ? "Active note is attached" : "Active note is excluded",
    );
    this.activeNoteToggleEl.setAttr(
      "title",
      including ? "Active note attached — click to exclude" : "Attach the active note — click to include",
    );

    if (activeNote) {
      const noteEl = this.contextRowEl.createSpan({ cls: "bolovan-chat__context-note" });
      setIcon(noteEl.createSpan({ cls: "bolovan-chat__context-icon" }), "file-text");
      noteEl.appendText(activeNote.basename);
      noteEl.setAttr("title", activeNote.path);
    }
    this.contextRowEl.createSpan({
      cls: "bolovan-chat__context-hint",
      text: including ? "· type [[ to attach more notes" : "type [[ to attach notes",
    });
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
  private showDialog(request: BolovanUiRequest): void {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }
    new BolovanDialogModal(this.app, request, (payload) => {
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
      this.composer.focus();
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
      const used = stats.contextUsage?.tokens;
      const contextWindow = stats.contextUsage?.contextWindow;
      const usageDetail = `${formatTokens(tokens)} tokens · $${cost.toFixed(3)}`;
      // `used` is null right after compaction until the next response.
      const contextText =
        typeof used === "number" && typeof contextWindow === "number"
          ? `${Math.round(used / 1000)}K/${Math.round(contextWindow / 1000)}K`
          : "Context —";
      this.statsEl.setText(contextText);
      this.statsEl.setAttr("title", usageDetail);
      this.statsEl.setAttr("aria-label", `${contextText}. ${usageDetail}`);
    } catch {
      this.statsEl.setText("");
    }
  }

  private updateEmptyState(): void {
    this.emptyEl.toggleClass("is-hidden", this.transcript.all().length > 0);
  }

  private onTranscriptScroll(): void {
    const distanceFromBottom =
      this.transcriptEl.scrollHeight - this.transcriptEl.scrollTop - this.transcriptEl.clientHeight;
    this.pinnedToBottom = distanceFromBottom < 48;
    this.jumpButtonEl.toggleClass("is-visible", !this.pinnedToBottom);
  }

  private scrollToBottom(force: boolean): void {
    if (!this.transcriptEl) {
      return;
    }
    if (force) {
      this.pinnedToBottom = true;
    }
    if (this.pinnedToBottom) {
      this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
    }
    this.jumpButtonEl?.toggleClass("is-visible", !this.pinnedToBottom);
  }
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fuzzy note chooser behind the composer's paperclip button. */
class NoteAttachModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly choose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Attach a note…");
  }

  getItems(): TFile[] {
    return [...this.app.vault.getMarkdownFiles()].sort(
      (a, b) => b.stat.mtime - a.stat.mtime,
    );
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

/**
 * Obsidian dialog answering a pi extension UI request. Esc or close counts
 * as cancellation, which extensions receive as a declined dialog.
 */
class BolovanDialogModal extends Modal {
  constructor(
    app: any,
    private readonly request: BolovanUiRequest,
    private readonly respond: (payload: Record<string, unknown>) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.request.title ?? "Bolovan");

    if (this.request.message) {
      this.contentEl.createEl("pre", {
        cls: "bolovan-dialog__message",
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
    const actions = this.contentEl.createDiv({ cls: "bolovan-dialog__actions" });
    const reject = actions.createEl("button", { text: "Reject" });
    reject.addEventListener("click", () => this.answer({ confirmed: false }));
    const approve = actions.createEl("button", { cls: "mod-cta", text: "Approve" });
    approve.addEventListener("click", () => this.answer({ confirmed: true }));
    reject.focus();
  }

  private buildSelect(): void {
    const select = this.contentEl.createEl("select");
    for (const option of this.request.options ?? []) {
      select.createEl("option", { value: option, text: option });
    }

    const actions = this.contentEl.createDiv({ cls: "bolovan-dialog__actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.answer({ cancelled: true }));
    const ok = actions.createEl("button", { cls: "mod-cta", text: "OK" });
    ok.addEventListener("click", () => this.answer({ value: select.value }));
    ok.focus();
  }

  private buildTextInput(): void {
    const textarea = this.contentEl.createEl("textarea", {
      cls: "bolovan-dialog__text",
      attr: { placeholder: this.request.placeholder ?? "" },
      text: this.request.prefill ?? "",
    });

    const actions = this.contentEl.createDiv({ cls: "bolovan-dialog__actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.answer({ cancelled: true }));
    const ok = actions.createEl("button", { cls: "mod-cta", text: "OK" });
    ok.addEventListener("click", () => this.answer({ value: textarea.value }));
    textarea.focus();
  }
}
