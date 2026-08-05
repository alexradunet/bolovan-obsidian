import { describe, expect, it } from "vitest";
import { Transcript, type TranscriptItem } from "../src/transcript";
import { buildPromptWithNotes } from "../src/context";
import type { BolovanEvent } from "../src/bolovan-agent";

function collectChanges(transcript: Transcript): TranscriptItem[] {
  const changes: TranscriptItem[] = [];
  transcript.subscribe((item) => changes.push(item));
  return changes;
}

function applyAll(transcript: Transcript, events: BolovanEvent[]): void {
  for (const event of events) {
    transcript.apply(event);
  }
}

describe("Transcript history mapping", () => {
  it("maps a user/assistant/tool exchange into paired items", () => {
    const transcript = new Transcript();

    transcript.loadHistory([
      { role: "user", content: "Summarize today's journal." },
      {
        role: "assistant",
        content: "Reading the note.",
        toolCalls: [
          {
            id: "call-1",
            name: "vault_read",
            arguments: { path: "Journal/Today.md" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "note body",
      },
      { role: "assistant", content: "A grounded summary." },
    ]);

    expect(transcript.all().map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const tool = transcript.all()[2];
    expect(tool).toMatchObject({
      kind: "tool",
      name: "vault_read",
      target: "Journal/Today.md",
      status: "done",
    });
    expect(transcript.all()[1]).toMatchObject({ finalized: true });
  });

  it("keeps user message text when attachments exist", () => {
    const transcript = new Transcript();

    transcript.loadHistory([
      {
        role: "user",
        content: "What is in this image?",
        attachments: [{ id: "img1", type: "image" }],
      },
    ]);

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({ kind: "user", text: "What is in this image?" });
  });

  it("splits attached-notes blocks out of history user messages", () => {
    const transcript = new Transcript();
    const prompt = buildPromptWithNotes("Summarize this.", [
      { path: "00-Inbox/Note.md", content: "note body" },
      { path: "02-Projects/Plan.md", content: "plan body" },
    ]);

    transcript.loadHistory([{ role: "user", content: prompt }]);

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({
      kind: "user",
      text: "Summarize this.",
      attachments: ["00-Inbox/Note.md", "02-Projects/Plan.md"],
    });
  });

  it("renders normalized assistant text", () => {
    const transcript = new Transcript();

    transcript.loadHistory([
      {
        role: "assistant",
        content: "visible answer",
      },
    ]);

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({ kind: "assistant", markdown: "visible answer" });
  });

  it("marks failed tools and surfaces the error text", () => {
    const transcript = new Transcript();

    transcript.loadHistory([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "vault_read",
            arguments: { path: "Missing.md" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "File not found",
      },
    ]);

    expect(transcript.all().map((item) => item.kind)).toEqual(["tool", "system"]);
    expect(transcript.all()[0]).toMatchObject({ kind: "tool", status: "error" });
    expect(transcript.all()[1]).toMatchObject({
      kind: "system",
      text: "Tool failed: File not found",
    });
  });

  it("renders persisted system markers as system lines", () => {
    const transcript = new Transcript();

    transcript.loadHistory([
      { role: "system", content: "Model changed: gpt-5.6-luna → gpt-5.6-sol" },
    ]);

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({ kind: "system", text: "Model changed: gpt-5.6-luna → gpt-5.6-sol" });
  });

  it("replaces previous items when loading a different session", () => {
    const transcript = new Transcript();
    transcript.loadHistory([{ role: "user", content: "old session" }]);

    transcript.loadHistory([{ role: "user", content: "new session" }]);

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({ kind: "user", text: "new session" });
  });
});

describe("Transcript live events", () => {
  it("grows one assistant item from deltas and finalizes on settled", () => {
    const transcript = new Transcript();
    const changes = collectChanges(transcript);

    applyAll(transcript, [
      { type: "text", delta: "Hello " },
      { type: "text", delta: "world" },
      { type: "settled" },
    ]);

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({
      kind: "assistant",
      markdown: "Hello world",
      finalized: true,
    });
    // Created once, grown twice, finalized once — all synchronously.
    expect(changes.filter((item) => item.id === transcript.all()[0]?.id)).toHaveLength(4);
  });

  it("finalizes the open block when a tool starts and pairs its end", () => {
    const transcript = new Transcript();

    applyAll(transcript, [
      { type: "text", delta: "Let me check." },
      { type: "tool-start", name: "read", args: { path: "Journal/Today.md" } },
      { type: "tool-end", name: "read", isError: false },
      { type: "text", delta: "Done." },
      { type: "settled" },
    ]);

    expect(transcript.all().map((item) => item.kind)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(transcript.all()[0]).toMatchObject({ finalized: true });
    expect(transcript.all()[1]).toMatchObject({
      kind: "tool",
      name: "read",
      target: "Journal/Today.md",
      status: "done",
    });
    expect(transcript.all()[2]).toMatchObject({ markdown: "Done.", finalized: true });
  });

  it("adds a final item when a tool end arrives without a start", () => {
    const transcript = new Transcript();

    transcript.apply({ type: "tool-end", name: "grep", isError: true });

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({ kind: "tool", name: "grep", status: "error" });
  });

  it("renders exited events as system lines", () => {
    const transcript = new Transcript();

    transcript.apply({ type: "exited", message: "Provider request failed." });

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({ kind: "system" });
  });
});

describe("Transcript continuity and surface messages", () => {
  it("appends live events after loaded history", () => {
    const transcript = new Transcript();
    transcript.loadHistory([{ role: "user", content: "earlier question" }]);

    transcript.say("follow-up question");
    applyAll(transcript, [
      { type: "text", delta: "follow-up answer" },
      { type: "settled" },
    ]);

    expect(transcript.all().map((item) => item.kind)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
  });

  it("notifies once per say and note", () => {
    const transcript = new Transcript();
    const changes = collectChanges(transcript);

    transcript.say("hello");
    transcript.note("Bolovan failed: provider unavailable");

    expect(changes.map((item) => item.kind)).toEqual(["user", "system"]);
  });

  it("runStarted opens a thinking placeholder the answer grows into", () => {
    const transcript = new Transcript();

    transcript.say("question");
    transcript.runStarted();

    expect(transcript.all()).toHaveLength(2);
    expect(transcript.all()[1]).toMatchObject({
      kind: "assistant",
      markdown: "",
      finalized: false,
    });

    applyAll(transcript, [
      { type: "text", delta: "Answer" },
      { type: "settled" },
    ]);

    expect(transcript.all()).toHaveLength(2);
    expect(transcript.all()[1]).toMatchObject({ markdown: "Answer", finalized: true });
  });

  it("runStarted does not duplicate a block that is already streaming", () => {
    const transcript = new Transcript();
    transcript.apply({ type: "text", delta: "streaming" });

    transcript.runStarted();

    expect(transcript.all()).toHaveLength(1);
  });

  it("settled finalizes an empty placeholder so the surface can hide it", () => {
    const transcript = new Transcript();
    transcript.runStarted();

    transcript.apply({ type: "settled" });

    expect(transcript.all()[0]).toMatchObject({
      kind: "assistant",
      markdown: "",
      finalized: true,
    });
  });

  it("records attached notes on user items and omits them when absent", () => {
    const transcript = new Transcript();

    transcript.say("with attachments", ["A.md", "B.md"]);
    transcript.say("without attachments");

    expect(transcript.all()[0]).toMatchObject({
      kind: "user",
      text: "with attachments",
      attachments: ["A.md", "B.md"],
    });
    expect(transcript.all()[1]).toMatchObject({ kind: "user", text: "without attachments" });
    expect((transcript.all()[1] as { attachments?: string[] }).attachments).toBeUndefined();
  });
});
