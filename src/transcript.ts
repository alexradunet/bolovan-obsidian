import type { BolovanEvent } from "./bolovan-agent";
import { splitAttachedNotes } from "./context";

export type TranscriptToolStatus = "running" | "done" | "error";

export interface TranscriptUserItem {
  kind: "user";
  id: string;
  text: string;
  /** Paths of vault notes attached to this message, if any. */
  attachments?: string[];
}

export interface TranscriptAssistantItem {
  kind: "assistant";
  id: string;
  markdown: string;
  finalized: boolean;
}

export interface TranscriptToolItem {
  kind: "tool";
  id: string;
  name: string;
  target: string;
  status: TranscriptToolStatus;
}

export interface TranscriptSystemItem {
  kind: "system";
  id: string;
  text: string;
}

export type TranscriptItem =
  | TranscriptUserItem
  | TranscriptAssistantItem
  | TranscriptToolItem
  | TranscriptSystemItem;

/**
 * The ordered on-screen record of a conversation. Items only ever append;
 * nothing reorders or disappears. The module owns every semantic rule —
 * streaming accumulation, block finalization, history mapping, and
 * tool-call pairing — and notifies synchronously per changed item. Painting
 * cadence is the adapter's concern, not the transcript's.
 */
export class Transcript {
  private itemList: TranscriptItem[] = [];
  private nextItemNumber = 0;
  private openAssistantId: string | undefined;
  private listeners = new Set<(item: TranscriptItem) => void>();

  subscribe(listener: (item: TranscriptItem) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  all(): readonly TranscriptItem[] {
    return this.itemList;
  }

  get(id: string): TranscriptItem | undefined {
    return this.itemList.find((item) => item.id === id);
  }

  /** Replace the transcript with the rendered history of a session. */
  loadHistory(messages: any[]): void {
    this.itemList = [];
    this.openAssistantId = undefined;

    for (const message of messages) {
      this.applyHistoryMessage(message);
    }
  }

  /** Apply one live agent event to the transcript. */
  apply(event: BolovanEvent): void {
    if (event.type === "text") {
      const item = this.openAssistant();
      item.markdown += event.delta;
      this.notify(item);
      return;
    }

    if (event.type === "tool-start") {
      this.finalizeOpenAssistant();
      this.notify(this.append({
        kind: "tool",
        name: event.name,
        target: toolTarget(event.args),
        status: "running",
      }));
      return;
    }

    if (event.type === "tool-end") {
      const item = this.runningTool(event.name);
      if (item) {
        item.status = event.isError ? "error" : "done";
        this.notify(item);
      } else {
        // An end without a start can arrive when the view attaches mid-run.
        this.notify(this.append({
          kind: "tool",
          name: event.name,
          target: "",
          status: event.isError ? "error" : "done",
        }));
      }
      return;
    }

    if (event.type === "settled") {
      this.finalizeOpenAssistant();
      return;
    }

    if (event.type === "exited") {
      this.note(event.message);
      return;
    }

    if (event.type === "notify") {
      this.note(event.message);
    }
    // ui-request is dialog traffic, not transcript content.
  }

  /** A user message sent from this surface, optionally with attached notes. */
  say(text: string, attachments?: string[]): void {
    this.finalizeOpenAssistant();
    this.notify(this.append({
      kind: "user",
      text,
      attachments: attachments?.length ? attachments : undefined,
    }));
  }

  /** A local notice: failures and other surface-level messages. */
  note(text: string): void {
    this.finalizeOpenAssistant();
    this.notify(this.append({ kind: "system", text }));
  }

  private openAssistant(): TranscriptAssistantItem {
    const open = this.openAssistantId ? this.get(this.openAssistantId) : undefined;
    if (open && open.kind === "assistant" && !open.finalized) {
      return open;
    }

    const item = this.append({ kind: "assistant", markdown: "", finalized: false });
    this.openAssistantId = item.id;
    this.notify(item);
    return item;
  }

  private finalizeOpenAssistant(): void {
    if (!this.openAssistantId) {
      return;
    }
    const item = this.get(this.openAssistantId);
    this.openAssistantId = undefined;
    if (item && item.kind === "assistant" && !item.finalized) {
      item.finalized = true;
      this.notify(item);
    }
  }

  private runningTool(name: string): TranscriptToolItem | undefined {
    for (let index = this.itemList.length - 1; index >= 0; index--) {
      const item = this.itemList[index];
      if (item && item.kind === "tool" && item.name === name && item.status === "running") {
        return item;
      }
    }
    return undefined;
  }

  private applyHistoryMessage(message: any): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.role === "user") {
      // pi's native attachments (images) are ignored, but the message text
      // stays — dropping the whole message was the old bug. Bolovan's own
      // attached-notes block is split out so only the typed text shows.
      const { text, paths } = splitAttachedNotes(messageText(message.content));
      if (text.trim()) {
        this.notify(this.append({
          kind: "user",
          text,
          attachments: paths.length ? paths : undefined,
        }));
      }
      return;
    }

    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block?.type === "text" && String(block.text ?? "").trim()) {
          this.finalizeOpenAssistant();
          this.notify(this.append({
            kind: "assistant",
            markdown: String(block.text),
            finalized: true,
          }));
        }
        if (block?.type === "toolCall") {
          this.finalizeOpenAssistant();
          this.notify(this.append({
            kind: "tool",
            name: String(block.name ?? "tool"),
            target: toolTarget(parseJson(block.arguments)),
            status: "running",
          }));
        }
        // Thinking blocks are skipped; they are not transcript content yet.
      }
      return;
    }

    if (message.role === "toolResult") {
      const paired = this.runningTool(String(message.toolName ?? ""));
      if (paired) {
        paired.status = message.isError ? "error" : "done";
        this.notify(paired);
      }
      if (message.isError) {
        const detail = messageText(message.content).slice(0, 400);
        this.notify(this.append({
          kind: "system",
          text: `${message.toolName ?? "tool"} failed: ${detail}`,
        }));
      }
      return;
    }

    if (message.role === "bashExecution" && message.command) {
      // Direct TUI bash commands keep shared sessions coherent; the output
      // itself stays out of the transcript.
      this.notify(this.append({ kind: "system", text: `ran \`${message.command}\`` }));
    }
  }

  private append(fields: Omit<TranscriptUserItem, "id">): TranscriptUserItem;
  private append(fields: Omit<TranscriptAssistantItem, "id">): TranscriptAssistantItem;
  private append(fields: Omit<TranscriptToolItem, "id">): TranscriptToolItem;
  private append(fields: Omit<TranscriptSystemItem, "id">): TranscriptSystemItem;
  private append(fields: any): any {
    const item = { ...fields, id: `item-${this.nextItemNumber}` };
    this.nextItemNumber += 1;
    this.itemList.push(item);
    return item;
  }

  private notify(item: TranscriptItem): void {
    for (const listener of this.listeners) {
      listener(item);
    }
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

function toolTarget(args: Record<string, unknown> | undefined): string {
  const target = args?.path ?? args?.command ?? args?.pattern ?? "";
  return String(target);
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
