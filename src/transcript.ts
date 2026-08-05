import type { BolovanEvent } from "./bolovan-agent";
import type { ModelMessage } from "./model-adapter";
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
  callId?: string;
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

type TranscriptHistoryMessage = ModelMessage & { attachments?: unknown };
type TranscriptItemFields =
  | Omit<TranscriptUserItem, "id">
  | Omit<TranscriptAssistantItem, "id">
  | Omit<TranscriptToolItem, "id">
  | Omit<TranscriptSystemItem, "id">;

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
  loadHistory(messages: TranscriptHistoryMessage[]): void {
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

  /**
   * A run started from this surface. Opens an empty assistant block as a
   * visible "thinking" placeholder; the first text delta grows into it. If
   * a block is already streaming, nothing happens.
   */
  runStarted(): void {
    const open = this.openAssistantId ? this.get(this.openAssistantId) : undefined;
    if (open && open.kind === "assistant" && !open.finalized) {
      return;
    }
    this.openAssistant();
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

  private applyHistoryMessage(message: TranscriptHistoryMessage): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.role === "user") {
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
      const text = messageText(message.content);
      if (text.trim()) {
        this.finalizeOpenAssistant();
        this.notify(this.append({
          kind: "assistant",
          markdown: text,
          finalized: true,
        }));
      }
      for (const call of message.toolCalls ?? []) {
        this.finalizeOpenAssistant();
        this.notify(this.append({
          kind: "tool",
          name: String(call.name ?? "tool"),
          target: toolTarget(call.arguments),
          status: "running",
          callId: String(call.id ?? ""),
        }));
      }
      return;
    }

    if (message.role === "tool") {
      const paired = this.runningToolById(String(message.toolCallId ?? ""));
      if (paired) {
        paired.status = toolResultIsError(message.content) ? "error" : "done";
        this.notify(paired);
      }
      if (toolResultIsError(message.content)) {
        const detail = messageText(message.content).slice(0, 400);
        this.notify(this.append({
          kind: "system",
          text: `Tool failed: ${detail}`,
        }));
      }
      return;
    }

    if (message.role === "system" && message.content) {
      this.notify(this.append({ kind: "system", text: String(message.content) }));
    }
  }

  private runningToolById(callId: string): TranscriptToolItem | undefined {
    for (let index = this.itemList.length - 1; index >= 0; index -= 1) {
      const item = this.itemList[index];
      if (item?.kind === "tool" && item.callId === callId && item.status === "running") {
        return item;
      }
    }
    return undefined;
  }

  private append(fields: Omit<TranscriptUserItem, "id">): TranscriptUserItem;
  private append(fields: Omit<TranscriptAssistantItem, "id">): TranscriptAssistantItem;
  private append(fields: Omit<TranscriptToolItem, "id">): TranscriptToolItem;
  private append(fields: Omit<TranscriptSystemItem, "id">): TranscriptSystemItem;
  private append(fields: TranscriptItemFields): TranscriptItem {
    const item = { ...fields, id: `item-${this.nextItemNumber}` } as TranscriptItem;
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
  const target = args?.path ?? args?.url ?? args?.command ?? args?.pattern ?? "";
  return String(target);
}

function toolResultIsError(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed?.isError === true;
  } catch {
    return /rejected|failed|not found|error/i.test(value);
  }
}
