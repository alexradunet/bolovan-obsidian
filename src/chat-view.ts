import { App, FuzzySuggestModal, ItemView, MarkdownRenderer, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type BolovanPlugin from "./main";
import type {
  BolovanApprovalRequest,
  BolovanConversationSnapshot,
  BolovanEvent,
} from "./bolovan-agent";
import { Composer } from "./composer";
import { mentionLabel, prepareAttachments, type NoteCandidate } from "./context";
import { Transcript, type TranscriptItem } from "./transcript";

export const BOLOVAN_CHAT_VIEW = "bolovan-chat-view";

const RENDER_THROTTLE_MS = 120;
const APPROVAL_EXCERPT_CHARACTERS = 2_000;
const APPROVAL_EXCERPT_LINES = 24;
const THINKING_MARKDOWN = "*Thinking…*";
const TOOL_REGISTRY: Record<string, { icon: string; name: string }> = {
  vault_read: { icon: "📄", name: "Read note" },
  vault_search: { icon: "🔍", name: "Search vault" },
  vault_list: { icon: "📁", name: "List folder" },
  vault_change: { icon: "✏️", name: "Change note" },
  web_read: { icon: "🌐", name: "Read webpage" },
};

type ToolAction = "preview" | "hide" | "open";

const TOOL_ACTION_REGISTRY: Record<ToolAction, { icon: string; name: string }> = {
  preview: { icon: "eye", name: "Preview" },
  hide: { icon: "eye-off", name: "Hide" },
  open: { icon: "external-link", name: "Open" },
};

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
  private readonly pendingApprovalEls = new Map<string, HTMLElement>();

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
      if (agent) {
        this.loadConversation(agent.conversation());
      }
      await this.refreshStats();
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

  /** Repaint existing tool calls after a display preference changes. */
  refreshToolDisplay(): void {
    for (const item of this.transcript.all()) {
      if (item.kind !== "tool") {
        continue;
      }
      const el = this.itemEls.get(item.id);
      if (el) {
        this.paintItem(item, el);
      }
    }
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

  private loadConversation(snapshot: BolovanConversationSnapshot): void {
    this.itemEls.clear();
    this.assistantPaintScheduled.clear();
    this.transcriptEl.empty();
    this.buildEmptyState();
    this.pinnedToBottom = true;

    this.transcript.loadHistory(snapshot.messages);
    this.populateSessionPicker(snapshot);
    this.setRunning(this.plugin.agent?.status().isRunning ?? false);
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
        const display = toolDisplay(item.name, item.target);
        const mode = this.plugin.config.toolDisplayMode ?? "icon";
        label.setAttr("title", display.description);
        label.setAttr("aria-label", display.description);
        if (mode !== "name") {
          label.createSpan({
            cls: "bolovan-tool__icon",
            text: display.icon,
            attr: { "aria-hidden": "true" },
          });
        }
        if (mode !== "icon") {
          label.createSpan({ cls: "bolovan-tool__name", text: display.name });
        }
        if (display.target) {
          // A tool target that is an existing note becomes a link that opens
          // it — created and edited files are one click away.
          const note = this.resolveNote(item.target);
          if (note) {
            label.createEl("a", {
              cls: "internal-link bolovan-tool__link",
              text: display.target,
              attr: { href: "#", "data-href": note.path },
            });
          } else {
            label.createSpan({ text: display.target });
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
    let actions = el.querySelector(".bolovan-tool__actions") as HTMLElement | null;
    const url = item.name === "web_read" && item.status === "done"
      ? webPreviewUrl(item.target)
      : undefined;
    if (!url) {
      actions?.remove();
      el.querySelector(".bolovan-tool__preview")?.remove();
      el.removeClass("is-expanded");
      return;
    }

    if (!actions) {
      actions = el.createDiv({ cls: "bolovan-tool__actions" });
      const previewButton = actions.createEl("button", {
        cls: "bolovan-tool__action",
        attr: { "data-action": "preview" },
      });
      previewButton.addEventListener("click", () => {
        const openPreview = el.querySelector(".bolovan-tool__preview");
        if (openPreview) {
          openPreview.remove();
          el.removeClass("is-expanded");
        } else {
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
          this.scrollToBottom(false);
        }
        this.paintToolAction(
          previewButton,
          el.querySelector(".bolovan-tool__preview") ? "hide" : "preview",
        );
        previewButton.setAttr(
          "aria-expanded",
          Boolean(el.querySelector(".bolovan-tool__preview")),
        );
      });

      actions.createEl("a", {
        cls: "bolovan-tool__action",
        attr: {
          "data-action": "open",
          href: url,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      });
    }

    const previewButton = actions.querySelector('[data-action="preview"]') as HTMLElement | null;
    const openLink = actions.querySelector('[data-action="open"]') as HTMLElement | null;
    const previewOpen = Boolean(el.querySelector(".bolovan-tool__preview"));
    if (previewButton) {
      this.paintToolAction(previewButton, previewOpen ? "hide" : "preview");
      previewButton.setAttr("aria-expanded", previewOpen);
    }
    if (openLink) {
      this.paintToolAction(openLink, "open");
    }
  }

  private paintToolAction(el: HTMLElement, action: ToolAction): void {
    const display = TOOL_ACTION_REGISTRY[action];
    const mode = this.plugin.config.toolActionDisplayMode ?? "name";
    el.empty();
    el.setAttr("aria-label", display.name);
    el.setAttr("title", display.name);
    if (mode !== "name") {
      setIcon(el, display.icon);
    }
    if (mode !== "icon") {
      el.appendText(display.name);
    }
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
    if (event.type === "conversation") {
      this.loadConversation(event.snapshot);
      return;
    }


    if (event.type === "settled") {
      this.transcript.apply(event);
      this.cancelPendingApprovalCards();
      this.setRunning(false);
      this.scrollToBottom(true);
      // Runs can create or fork a Branch, so refresh its summaries from the
      // same Harness snapshot used by explicit Conversation transitions.
      const agent = this.plugin.agent;
      if (agent) {
        this.populateSessionPicker(agent.conversation());
      }
      void this.refreshStats().catch(() => undefined);
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

    const { notes, warnings, prompt } = await prepareAttachments(
      this.app,
      text,
      this.plugin.includeActiveNote ? this.plugin.activeNote() : undefined,
    );
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

  /** Keep a prepared change in the conversation while the Harness waits. */
  private showApproval(request: BolovanApprovalRequest): void {
    const agent = this.plugin.agent;
    if (!agent) {
      return;
    }

    const card = this.transcriptEl.createDiv({
      cls: "bolovan-approval",
      attr: { role: "group", "aria-label": `Approval required: ${request.title}` },
    });
    card.createDiv({ cls: "bolovan-approval__eyebrow", text: "Approval required" });
    card.createEl("h3", { cls: "bolovan-approval__title", text: request.title });

    const previewTruncated = paintApprovalPreview(card, request, true);

    if (previewTruncated) {
      const inspection = card.createDiv({ cls: "bolovan-approval__inspection" });
      inspection.createSpan({
        cls: "bolovan-approval__truncation",
        text: "Excerpt shown",
      });
      const inspect = inspection.createEl("button", { text: "Full-screen" });
      inspect.addEventListener("click", () => {
        new BolovanApprovalInspectionModal(this.app, request).open();
      });
    }

    const actions = card.createDiv({ cls: "bolovan-approval__actions" });
    const status = actions.createSpan({ cls: "bolovan-approval__status" });
    const decline = actions.createEl("button", { text: "Decline" });
    decline.addEventListener("click", () => {
      this.answerApproval(request, card, false);
    });
    const approve = actions.createEl("button", { cls: "mod-cta", text: "Approve" });
    approve.addEventListener("click", () => {
      this.answerApproval(request, card, true);
    });

    status.setAttr("aria-live", "polite");
    this.pendingApprovalEls.set(request.id, card);
    decline.focus();
    this.scrollToBottom(false);
  }

  private answerApproval(
    request: BolovanApprovalRequest,
    card: HTMLElement,
    approved: boolean,
  ): void {
    if (!this.pendingApprovalEls.delete(request.id)) {
      return;
    }
    this.finishApprovalCard(card, approved ? "Approved" : "Declined");
    this.plugin.agent?.respondApproval(request.id, approved);
  }

  private cancelPendingApprovalCards(): void {
    for (const card of this.pendingApprovalEls.values()) {
      this.finishApprovalCard(card, "Cancelled");
    }
    this.pendingApprovalEls.clear();
  }

  private finishApprovalCard(card: HTMLElement, result: string): void {
    const actions = card.querySelector(".bolovan-approval__actions");
    const status = card.querySelector(".bolovan-approval__status");
    actions?.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    status?.setText(result);
    card.addClass("is-answered");
  }

  // ----- controls ----------------------------------------------------------

  private populateSessionPicker(snapshot: BolovanConversationSnapshot): void {
    const { activeBranch, sessions } = snapshot;
    this.sessionSelectEl.empty();
    for (const session of sessions) {
      this.sessionSelectEl.createEl("option", {
        value: session.path,
        text: session.label,
      });
    }
    if (activeBranch && !sessions.some((session) => session.path === activeBranch)) {
      this.sessionSelectEl.createEl("option", { value: activeBranch, text: "current session" });
    }
    if (activeBranch) {
      this.sessionSelectEl.value = activeBranch;
    }
  }

  private async switchToSelectedSession(): Promise<void> {
    const agent = this.plugin.agent;
    const target = this.sessionSelectEl.value;
    if (!agent || !target || target === agent.conversation().activeBranch) {
      return;
    }
    try {
      await agent.switchSession(target);
      await this.refreshStats();
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
      await this.refreshStats();
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

function toolDisplay(
  name: string,
  target: string,
): { icon: string; name: string; target: string; description: string } {
  const tool = TOOL_REGISTRY[name] ?? { icon: "🛠️", name: "Tool call" };
  let conciseTarget = target.slice(0, 80);
  if (name === "web_read") {
    const url = webPreviewUrl(target);
    conciseTarget = url ? new URL(url).hostname.replace(/^www\./i, "") : "";
  }
  const description = conciseTarget
    ? `${tool.name}: ${conciseTarget}`
    : tool.name;
  return { ...tool, target: conciseTarget, description };
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

type ApprovalDiffKind = "context" | "removed" | "added" | "omitted";

interface ApprovalDiffLine {
  kind: ApprovalDiffKind;
  text: string;
}

function paintApprovalPreview(
  host: HTMLElement,
  request: BolovanApprovalRequest,
  excerpt: boolean,
): boolean {
  if (!request.diff) {
    const preview = excerpt
      ? approvalExcerpt(request.message)
      : { text: request.message, truncated: false };
    host.createEl("pre", {
      cls: "bolovan-approval__preview",
      text: preview.text,
    });
    return preview.truncated;
  }

  const preview = approvalDiffLines(request.diff.before, request.diff.after, excerpt);
  const diff = host.createDiv({ cls: "bolovan-approval__preview bolovan-approval__diff" });
  for (const row of preview.lines) {
    const line = diff.createDiv({
      cls: `bolovan-approval__diff-line is-${row.kind}`,
    });
    line.createSpan({
      cls: "bolovan-approval__diff-marker",
      text: row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " ",
    });
    line.createSpan({ cls: "bolovan-approval__diff-text", text: row.text });
  }
  return preview.truncated;
}

function approvalDiffLines(
  before: string,
  after: string,
  excerpt: boolean,
): { lines: ApprovalDiffLine[]; truncated: boolean } {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  if (!excerpt) {
    return {
      lines: [
        ...beforeLines.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
        ...beforeLines.slice(prefix, beforeLines.length - suffix).map((text) => ({
          kind: "removed" as const,
          text,
        })),
        ...afterLines.slice(prefix, afterLines.length - suffix).map((text) => ({
          kind: "added" as const,
          text,
        })),
        ...afterLines.slice(afterLines.length - suffix).map((text) => ({
          kind: "context" as const,
          text,
        })),
      ],
      truncated: false,
    };
  }

  const lines: ApprovalDiffLine[] = [];
  let truncated = false;
  const prefixStart = Math.max(0, prefix - 2);
  if (prefixStart > 0) {
    lines.push({ kind: "omitted", text: `${prefixStart} unchanged lines` });
    truncated = true;
  }
  for (const text of beforeLines.slice(prefixStart, prefix)) {
    lines.push({ kind: "context", text });
  }

  const removedStart = prefix;
  const removedEnd = beforeLines.length - suffix;
  const addedStart = prefix;
  const addedEnd = afterLines.length - suffix;
  const hasRemoved = removedEnd > removedStart;
  const hasAdded = addedEnd > addedStart;
  const changedLineLimit = hasRemoved && hasAdded ? 8 : 16;
  const changedCharacterLimit = hasRemoved && hasAdded ? 900 : 1_800;
  const removed = boundedDiffLines(
    beforeLines,
    removedStart,
    removedEnd,
    "removed",
    changedLineLimit,
    changedCharacterLimit,
  );
  const added = boundedDiffLines(
    afterLines,
    addedStart,
    addedEnd,
    "added",
    changedLineLimit,
    changedCharacterLimit,
  );
  lines.push(...removed.lines, ...added.lines);
  truncated ||= removed.truncated || added.truncated;

  const suffixEnd = Math.min(afterLines.length, afterLines.length - suffix + 2);
  for (const text of afterLines.slice(afterLines.length - suffix, suffixEnd)) {
    lines.push({ kind: "context", text });
  }
  if (suffixEnd < afterLines.length) {
    lines.push({
      kind: "omitted",
      text: `${afterLines.length - suffixEnd} unchanged lines`,
    });
    truncated = true;
  }
  return { lines, truncated };
}

function boundedDiffLines(
  source: string[],
  start: number,
  end: number,
  kind: "removed" | "added",
  maxLines: number,
  maxCharacters: number,
): { lines: ApprovalDiffLine[]; truncated: boolean } {
  const lines: ApprovalDiffLine[] = [];
  let characters = 0;
  let index = start;
  while (index < end && lines.length < maxLines && characters < maxCharacters) {
    const available = maxCharacters - characters;
    const current = source[index];
    if (current === undefined) {
      break;
    }
    const text = current.slice(0, available);
    lines.push({ kind, text });
    characters += text.length;
    if (text.length < current.length) {
      break;
    }
    index += 1;
  }
  const truncated = index < end;
  if (truncated) {
    lines.push({ kind: "omitted", text: `${end - index} ${kind} lines omitted` });
  }
  return { lines, truncated };
}

function approvalExcerpt(message: string): { text: string; truncated: boolean } {
  let end = 0;
  let lines = 1;
  while (end < message.length && end < APPROVAL_EXCERPT_CHARACTERS) {
    if (message.charAt(end) === "\n") {
      if (lines === APPROVAL_EXCERPT_LINES) {
        break;
      }
      lines += 1;
    }
    end += 1;
  }
  return {
    text: message.slice(0, end),
    truncated: end < message.length,
  };
}

/** Full prepared-change inspection, opened only when the user requests it. */
class BolovanApprovalInspectionModal extends Modal {
  constructor(
    app: App,
    private readonly request: BolovanApprovalRequest,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("bolovan-approval-inspection");
    this.titleEl.setText(this.request.title);
    paintApprovalPreview(this.contentEl, this.request, false);
    if (this.request.diff) {
      const exact = this.contentEl.createEl("details", {
        cls: "bolovan-approval-inspection__exact",
      });
      exact.createEl("summary", { text: "Exact operation and resulting content" });
      exact.createEl("pre", {
        cls: "bolovan-dialog__message",
        text: this.request.message,
      });
    }
  }
}
