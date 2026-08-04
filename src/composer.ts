import {
  matchNoteCandidates,
  MENTION_PATTERN,
  mentionLabel,
  mentionTokenAt,
  type MentionToken,
  type NoteCandidate,
} from "./context";

const LINK_CLASS = "bolovan-chat__mention-link";

export interface ComposerOptions {
  /** Where the editable element is built. */
  editorHost: HTMLElement;
  /** Where the floating mention picker attaches; it floats above this. */
  pickerHost: HTMLElement;
  /** Mention candidates, typically all vault notes newest-first. */
  getNotes: () => NoteCandidate[];
  /** Called on Enter without Shift. */
  onSend: () => void;
}

/**
 * The chat input: a contenteditable line where note mentions render as
 * Obsidian-style links. Links serialize back to `[[label]]` wikilinks, so
 * the outgoing prompt is plain text and nothing downstream changes.
 * Clicking a link expands it into editable `[[label]]` text — like live
 * preview — and it collapses back once the caret leaves.
 */
export class Composer {
  readonly el: HTMLDivElement;
  private readonly picker: MentionPicker;
  private composing = false;

  constructor(private readonly options: ComposerOptions) {
    const doc = options.editorHost.ownerDocument;
    this.el = doc.createElement("div");
    this.el.className = "bolovan-chat__editor";
    this.el.setAttribute("contenteditable", "true");
    this.el.setAttribute("role", "textbox");
    this.el.setAttribute("aria-multiline", "true");
    this.el.setAttribute("aria-label", "Message Bolovan");
    this.el.setAttribute("data-placeholder", "Ask Bolovan…");
    options.editorHost.appendChild(this.el);

    this.el.addEventListener("input", () => this.refresh());
    this.el.addEventListener("keyup", () => this.refresh());
    this.el.addEventListener("click", (event) => this.onClick(event));
    this.el.addEventListener("blur", () => this.picker.close());
    this.el.addEventListener("keydown", (event) => this.onKeydown(event));
    this.el.addEventListener("paste", (event) => this.onPaste(event));
    this.el.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.el.addEventListener("compositionend", () => {
      this.composing = false;
      this.refresh();
    });

    this.picker = new MentionPicker(this, options.pickerHost, options.getNotes);
  }

  /** Plain text of the message; links appear as their [[label]] form. */
  getText(): string {
    return extractText(this.el);
  }

  setText(text: string): void {
    this.el.textContent = text;
  }

  clear(): void {
    this.el.textContent = "";
  }

  focus(): void {
    this.el.focus();
  }

  /** The mention being typed at the caret, if any. */
  mentionToken(): MentionToken | undefined {
    const caret = this.caretOffset();
    if (caret < 0) {
      return undefined;
    }
    return mentionTokenAt(this.getText(), caret);
  }

  /** Replace a mention token with its link; used by the picker. */
  replaceTokenWithLink(token: MentionToken, note: NoteCandidate): void {
    const label = mentionLabel(note, this.options.getNotes());
    const start = this.locate(token.start);
    const end = this.locate(token.end);
    const range = this.el.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    range.deleteContents();
    const link = this.makeLink(label);
    range.insertNode(link);
    this.placeCaretAfter(link);
  }

  /** Insert a mention link at the caret; used by the paperclip chooser. */
  insertMention(label: string): void {
    // The chooser modal steals focus, so an absent caret means "append".
    const caretOffset = this.caretOffset();
    const caret = caretOffset < 0 ? this.getText().length : caretOffset;
    const needsSpace = caret > 0 && !/\s/.test(this.getText().charAt(caret - 1));
    const position = this.locate(caret);
    const range = this.el.ownerDocument.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);

    const fragment = this.el.ownerDocument.createDocumentFragment();
    if (needsSpace) {
      fragment.appendChild(this.el.ownerDocument.createTextNode(" "));
    }
    const link = this.makeLink(label);
    fragment.appendChild(link);
    range.insertNode(fragment);
    this.placeCaretAfter(link);
    this.focus();
  }

  // ----- editor events -----------------------------------------------------

  /** Decorate finished mentions and sync the picker after any change. */
  private refresh(): void {
    // Browsers can leave a stray <br> behind after deleting everything;
    // it would hide the placeholder and count as a newline.
    if (this.el.textContent === "" && this.el.childNodes.length > 0) {
      this.el.textContent = "";
    }
    this.decorate();
    this.picker.update();
  }

  private onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const link = target.closest(`.${LINK_CLASS}`);
    if (link && this.el.contains(link)) {
      this.unwrapLink(link as HTMLElement);
      return;
    }
    this.refresh();
  }

  private onKeydown(event: KeyboardEvent): void {
    if (this.picker.handleKeydown(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (event.shiftKey) {
        this.insertLineBreak();
        return;
      }
      this.options.onSend();
    }
  }

  private onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData("text/plain");
    event.preventDefault();
    if (!text) {
      return;
    }

    const selection = this.el.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = this.el.ownerDocument.createTextNode(text);
    range.insertNode(node);
    this.placeCaretAfter(node);
    this.refresh();
  }

  // ----- links ---------------------------------------------------------------

  /** Clicking a link expands it so its label can be edited as plain text. */
  private unwrapLink(link: HTMLElement): void {
    const label = link.dataset.label ?? link.textContent ?? "";
    const textNode = this.el.ownerDocument.createTextNode(`[[${label}]]`);
    link.replaceWith(textNode);
    const range = this.el.ownerDocument.createRange();
    range.setStart(textNode, textNode.nodeValue?.length ?? 0);
    range.collapse(true);
    this.setSelection(range);
    this.picker.update();
  }

  /**
   * Turn completed [[mention]] text into links, keeping the full inner
   * label (heading and alias included). Existing links are skipped
   * structurally (they are not text nodes) and the token holding the caret
   * stays editable.
   */
  private decorate(): void {
    if (this.composing) {
      return;
    }

    const caret = this.caretOffset();
    const replacements: { node: Text; start: number; end: number; label: string }[] = [];
    let base = 0;

    const scan = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue ?? "";
        for (const match of value.matchAll(MENTION_PATTERN)) {
          const start = base + (match.index ?? 0);
          const end = start + match[0].length;
          const holdsCaret = caret >= start && caret <= end;
          if (!holdsCaret) {
            replacements.push({
              node: node as Text,
              start: match.index ?? 0,
              end: (match.index ?? 0) + match[0].length,
              // The inner label, heading and alias included, so unwrapping
              // restores exactly what the user typed.
              label: match[0].slice(2, -2),
            });
          }
        }
        base += value.length;
        return;
      }
      if (isLinkElement(node)) {
        base += linkSerialized(node).length;
        return;
      }
      if (node.nodeName === "BR") {
        base += 1;
        return;
      }
      for (const child of Array.from(node.childNodes)) {
        scan(child);
      }
    };
    scan(this.el);

    // Replacing from the end keeps earlier offsets valid.
    for (const replacement of replacements.reverse()) {
      const range = this.el.ownerDocument.createRange();
      range.setStart(replacement.node, replacement.start);
      range.setEnd(replacement.node, replacement.end);
      range.deleteContents();
      range.insertNode(this.makeLink(replacement.label));
    }
  }

  private makeLink(label: string): HTMLElement {
    const link = this.el.ownerDocument.createElement("span");
    link.className = LINK_CLASS;
    link.setAttribute("contenteditable", "false");
    link.dataset.label = label;
    link.textContent = linkDisplay(label);
    link.title = label;
    return link;
  }

  // ----- caret and positions -------------------------------------------------

  /** Caret offset in plain-text coordinates; -1 when focus is elsewhere. */
  private caretOffset(): number {
    const selection = this.el.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return -1;
    }
    const range = selection.getRangeAt(0);
    if (!this.el.contains(range.startContainer)) {
      return -1;
    }
    const prefix = range.cloneRange();
    prefix.selectNodeContents(this.el);
    prefix.setEnd(range.startContainer, range.startOffset);
    return extractText(prefix.cloneContents()).length;
  }

  /** DOM position for a plain-text offset. Links and BRs count as units. */
  private locate(offset: number): { node: Node; offset: number } {
    let remaining = offset;

    const before = (node: Node): { node: Node; offset: number } => {
      const parent = node.parentNode ?? this.el;
      return { node: parent, offset: Array.from(parent.childNodes).indexOf(node as ChildNode) };
    };

    const walk = (node: Node): { node: Node; offset: number } | undefined => {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = (node.nodeValue ?? "").length;
        if (remaining <= length) {
          return { node, offset: remaining };
        }
        remaining -= length;
        return undefined;
      }
      if (isLinkElement(node)) {
        const length = linkSerialized(node).length;
        if (remaining < length) {
          return before(node);
        }
        remaining -= length;
        return undefined;
      }
      if (node.nodeName === "BR") {
        if (remaining < 1) {
          return before(node);
        }
        remaining -= 1;
        return undefined;
      }
      for (const child of Array.from(node.childNodes)) {
        const found = walk(child);
        if (found) {
          return found;
        }
      }
      return undefined;
    };

    return walk(this.el) ?? { node: this.el, offset: this.el.childNodes.length };
  }

  private insertLineBreak(): void {
    const caret = this.caretOffset();
    if (caret < 0) {
      return;
    }
    const position = this.locate(caret);
    const range = this.el.ownerDocument.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    const br = this.el.ownerDocument.createElement("br");
    range.insertNode(br);
    this.placeCaretAfter(br);
  }

  private placeCaretAfter(node: Node): void {
    const range = this.el.ownerDocument.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    this.setSelection(range);
  }

  private setSelection(range: Range): void {
    const selection = this.el.ownerDocument.getSelection();
    if (!selection) {
      return;
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/** The mention picker, anchored to the composer above the editor. */
class MentionPicker {
  private readonly el: HTMLElement;
  private candidates: NoteCandidate[] = [];
  private selectedIndex = 0;
  private token: MentionToken | undefined;
  private suppressedTokenStart = -1;

  constructor(
    private readonly composer: Composer,
    pickerHost: HTMLElement,
    private readonly getNotes: () => NoteCandidate[],
  ) {
    this.el = pickerHost.ownerDocument.createElement("div");
    this.el.className = "bolovan-chat__picker";
    this.el.style.display = "none";
    pickerHost.appendChild(this.el);
  }

  isOpen(): boolean {
    return this.token !== undefined;
  }

  /**
   * Keyboard handling while the picker is open. Returns true when the event
   * was consumed so the composer neither sends nor inserts the character.
   */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.isOpen()) {
      return false;
    }
    if (event.key === "ArrowDown") {
      this.move(1);
      return true;
    }
    if (event.key === "ArrowUp") {
      this.move(-1);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const selected = this.candidates[this.selectedIndex];
      if (selected) {
        this.commit(selected);
      }
      return true;
    }
    if (event.key === "Escape") {
      // Stay closed until the user starts a fresh mention token.
      this.suppressedTokenStart = this.token?.start ?? -1;
      this.close();
      return true;
    }
    return false;
  }

  /** Re-read the caret, refresh the candidate list, repaint. */
  update(): void {
    const token = this.composer.mentionToken();
    if (!token || token.start === this.suppressedTokenStart) {
      this.close();
      return;
    }

    this.token = token;
    const notes = this.getNotes();
    const query = token.query.trim();
    this.candidates = query ? matchNoteCandidates(notes, query) : notes.slice(0, 8);
    if (this.candidates.length === 0) {
      this.close();
      return;
    }
    if (this.selectedIndex >= this.candidates.length) {
      this.selectedIndex = 0;
    }
    this.render();
  }

  close(): void {
    this.token = undefined;
    this.el.empty();
    this.el.style.display = "none";
  }

  private move(delta: number): void {
    const count = this.candidates.length;
    if (count === 0) {
      return;
    }
    this.selectedIndex = (this.selectedIndex + delta + count) % count;
    this.paintSelection();
  }

  private commit(note: NoteCandidate): void {
    if (!this.token) {
      return;
    }
    this.composer.replaceTokenWithLink(this.token, note);
    this.close();
  }

  private render(): void {
    this.el.empty();
    this.el.style.display = "";
    this.candidates.forEach((note, index) => {
      const item = this.el.createDiv({ cls: "bolovan-chat__picker-item" });
      item.toggleClass("is-selected", index === this.selectedIndex);
      item.createSpan({ cls: "bolovan-chat__picker-name", text: note.basename });
      item.createSpan({ cls: "bolovan-chat__picker-path", text: folderOf(note.path) });
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = index;
        this.paintSelection();
      });
      item.addEventListener("mousedown", (event) => {
        // mousedown (not click), with preventDefault so the editor keeps
        // focus instead of blurring and closing the picker first.
        event.preventDefault();
        this.commit(note);
      });
    });
  }

  private paintSelection(): void {
    const items = this.el.querySelectorAll(".bolovan-chat__picker-item");
    items.forEach((item, index) => {
      item.toggleClass("is-selected", index === this.selectedIndex);
    });
  }
}

function folderOf(path: string): string {
  const folder = path.split("/").slice(0, -1).join("/");
  return folder || "/";
}

function isLinkElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.classList.contains(LINK_CLASS);
}

function linkSerialized(link: HTMLElement): string {
  return `[[${link.dataset.label ?? link.textContent ?? ""}]]`;
}

/** Alias when present, otherwise the basename of the linked path. */
function linkDisplay(label: string): string {
  const alias = label.split("|")[1]?.trim();
  if (alias) {
    return alias;
  }
  const pathPart = label.split("|")[0]?.split("#")[0] ?? label;
  return pathPart.split("/").pop() || label;
}

/** Plain-text form of any DOM fragment: text nodes, links, and newlines. */
function extractText(root: Node): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? "";
      return;
    }
    if (isLinkElement(node)) {
      out += linkSerialized(node);
      return;
    }
    if (node.nodeName === "BR") {
      out += "\n";
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }
  };
  walk(root);
  return out;
}
