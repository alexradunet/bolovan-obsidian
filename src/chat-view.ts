import { App, FuzzySuggestModal, ItemView, MarkdownRenderer, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type BolovanPlugin from "./main";
import type { BolovanApprovalRequest, BolovanEvent } from "./bolovan-agent";
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
 * Sidebar chat over Bolovan's Obsidian-native harness. The view is a thin
 * adapter over the Transcript: it paints items keyed by id and owns nothing
 * but DOM concerns — throttling, scrolling, and dialogs.
 */
export class BolovanChatView extends ItemView {
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
  private statsEl!: HTMLElement;
  private pinnedToBottom = true;

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
    this.buildLayout();
    this.unsubscribeTranscript = this.transcript.subscribe((item) =>
      this.onTranscriptChange(item),
    );
    // The harness lives for the plugin's lifetime, so the view attaches to it
    // directly; nothing swaps it out from under us.
    const agent = this.plugin.agent;
    if (agent) {
      this.unsubscribeAgent = agent.subscribe((event) => this.onAgentEvent(event));
      agent.setApprovalResponder((request) => this.showApproval(request));
    }

    try {
      await this.plugin.startAgent();
      await Promise.all([
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
    this.plugin.agent?.setApprovalResponder(undefined);
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = undefined;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = undefined;
    void this.plugin.agent?.cancel();
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

    this.statsEl = controls.createSpan({ cls: "bolovan-chat__stats" });

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
      const last = this.transcriptEl.lastElementChild;
      const group = last?.classList.contains("bolovan-tool-group")
        ? last as HTMLElement
        : this.transcriptEl.createDiv({ cls: "bolovan-tool-group" });
      el = group.createDiv({ cls: "bolovan-tool" });
      el.createSpan({ cls: "bolovan-tool__status" });
      el.createSpan({ cls: "bolovan-tool__label" });
      el.toggleClass("bolovan-tool--web", item.name === "web_read");
    } else {
      el = this.transcriptEl.createDiv({ cls: `bolovan-message bolovan-message--${item.kind}` });
    }
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
      void MarkdownRenderer.render(this.app, item.markdown || THINKING_MARKDOWN, el, "", this)
        .then(() => this.scrollToBottom(false));
      return;
    }

    if (item.kind === "tool") {
      const status = el.querySelector(".bolovan-tool__status") as HTMLElement | null;
      const label = el.querySelector(".bolovan-tool__label") as HTMLElement | null;
      status?.setText(item.status === "running" ? "…" : item.status === "done" ? "✓" : "✗");
      if (label) {
        label.empty();
        label.setAttr("title", item.target ? `${item.name} · ${item.target}` : item.name);
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
        this.paintWebActions(item, el);
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
  private paintWebActions(item: Extract<TranscriptItem, { kind: "tool" }>, el: HTMLElement): void {
    const existing = el.querySelector(".bolovan-tool__actions");
    const url = item.name === "web_read" && item.status === "done"
      ? webPreviewUrl(item.target)
      : undefined;
    if (!url) {
      existing?.remove();
      el.querySelector(".bolovan-tool__preview")?.remove();
      el.removeClass("is-expanded");
      return;
    }
    if (existing) {
      return;
    }

    const actions = el.createDiv({ cls: "bolovan-tool__actions" });
    const previewButton = actions.createEl("button", {
      cls: "bolovan-tool__action",
      text: "Preview",
      attr: { "aria-expanded": "false" },
    });
    previewButton.addEventListener("click", () => {
      const openPreview = el.querySelector(".bolovan-tool__preview");
      if (openPreview) {
        openPreview.remove();
        previewButton.setText("Preview");
        previewButton.setAttr("aria-expanded", "false");
        el.removeClass("is-expanded");
        return;
      }

      el.createEl("iframe", {
        cls: "bolovan-tool__preview",
        attr: {
          src: url,
          title: `Preview of ${new URL(url).hostname}`,
          loading: "lazy",
          referrerpolicy: "no-referrer",
          sandbox: "allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
        },
      });
      el.addClass("is-expanded");
      previewButton.setText("Hide");
      previewButton.setAttr("aria-expanded", "true");
      this.scrollToBottom(false);
    });

    actions.createEl("a", {
      cls: "bolovan-tool__action",
      text: "Open",
      attr: {
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    });
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
      void MarkdownRenderer.render(this.app, item.markdown || THINKING_MARKDOWN, el, "", this)
        .then(() => this.scrollToBottom(false));
    }, RENDER_THROTTLE_MS);
  }

  // ----- agent events ------------------------------------------------------

  private onAgentEvent(event: BolovanEvent): void {

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

    if (event.type === "text" || event.type === "tool-start") {
      this.setRunning(true);
    }
    this.transcript.apply(event);
  }

  private setRunning(running: boolean): void {
    this.rootEl.toggleClass("is-running", running);
    this.sendButtonEl.setText(running ? "Stop" : "Send");
    this.sendButtonEl.setAttr("aria-label", running ? "Stop response" : "Send message");
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
    return (
      this.app.vault.getFileByPath(href)
      ?? this.app.metadataCache.getFirstLinkpathDest(href, "")
      ?? undefined
    );
  }

  /** Open an attached note from the transcript. */
  private async openAttachment(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      new Notice(`This note no longer exists: ${path}`);
      return;
    }
    await this.openNote(file);
  }

  /** Open a note without ever replacing the chat surface itself. */
  private async openNote(file: TFile): Promise<void> {
    try {
      // The most recent root-split leaf is the note surface; a new tab is
      // the fallback when none exists or it is the chat leaf itself.
      const recent = this.app.workspace.getMostRecentLeaf();
      const leaf = recent && recent !== this.leaf
        ? recent
        : this.app.workspace.getLeaf("tab");
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

  /** Exact-change approval surface for the harness. */
  private showApproval(request: BolovanApprovalRequest): void {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }
    new BolovanApprovalModal(this.app, request, (approved) => {
      agent.respondApproval(request.id, approved);
    }).open();
  }

  // ----- controls ----------------------------------------------------------

  private async populateSessionPicker(): Promise<void> {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }

    const sessions = agent.listSessions();
    const current = agent.status().activeBranch;

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
    if (!agent || !target || target === agent.status().activeBranch) {
      return;
    }
    try {
      await agent.switchSession(target);
      await Promise.all([this.loadTranscript(), this.refreshStats()]);
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
          ? `${formatContextSize(used)}/${formatContextSize(contextWindow)}`
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

/** Context sizes in K, promoted to M once they reach 1000K. */
function formatContextSize(tokens: number): string {
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) {
    return `${thousands}K`;
  }
  return `${parseFloat((thousands / 1000).toFixed(1))}M`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function webPreviewUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const isWebUrl = url.protocol === "http:" || url.protocol === "https:";
    if (!isWebUrl || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
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

/** Obsidian dialog for an exact change approval. */
class BolovanApprovalModal extends Modal {
  constructor(
    app: App,
    private readonly request: BolovanApprovalRequest,
    private readonly respond: (approved: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.request.title);
    this.contentEl.createEl("pre", {
      cls: "bolovan-dialog__message",
      text: this.request.message,
    });

    const actions = this.contentEl.createDiv({ cls: "bolovan-dialog__actions" });
    const reject = actions.createEl("button", { text: "Reject" });
    reject.addEventListener("click", () => this.answer(false));
    const approve = actions.createEl("button", { cls: "mod-cta", text: "Approve" });
    approve.addEventListener("click", () => this.answer(true));
    reject.focus();
  }

  onClose(): void {
    this.respond(false);
  }

  private answer(approved: boolean): void {
    this.respond(approved);
    this.close();
  }
}
