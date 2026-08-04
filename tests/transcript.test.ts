import { describe, expect, it } from "vitest";
import { Transcript, type TranscriptItem } from "../src/transcript";
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
        content: [
          { type: "text", text: "Reading the note." },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: '{"path":"Journal/Today.md"}',
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "note body" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "A grounded summary." }] },
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
      name: "read",
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

  it("skips thinking blocks", () => {
    const transcript = new Transcript();

    transcript.loadHistory([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "visible answer" },
        ],
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
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: '{"path":"Missing.md"}',
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "File not found" }],
        isError: true,
      },
    ]);

    expect(transcript.all().map((item) => item.kind)).toEqual(["tool", "system"]);
    expect(transcript.all()[0]).toMatchObject({ kind: "tool", status: "error" });
    expect(transcript.all()[1]).toMatchObject({
      kind: "system",
      text: "read failed: File not found",
    });
  });

  it("renders direct bash commands as system lines", () => {
    const transcript = new Transcript();

    transcript.loadHistory([
      { role: "bashExecution", command: "ls -la", output: "…", exitCode: 0 },
    ]);

    expect(transcript.all()).toHaveLength(1);
    expect(transcript.all()[0]).toMatchObject({ kind: "system", text: "ran `ls -la`" });
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

  it("renders notify and exited events as system lines", () => {
    const transcript = new Transcript();

    applyAll(transcript, [
      { type: "notify", message: "Command blocked", notifyType: "warning" },
      { type: "exited", message: "pi exited (code 1). Tried pi." },
    ]);

    expect(transcript.all().map((item) => item.kind)).toEqual(["system", "system"]);
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
    transcript.note("Bolovan failed: pi exited");

    expect(changes.map((item) => item.kind)).toEqual(["user", "system"]);
  });
});
