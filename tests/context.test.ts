import { describe, expect, it } from "vitest";
import {
  buildPromptWithNotes,
  matchNoteCandidates,
  MAX_ATTACHMENT_CHARS,
  mentionLabel,
  mentionTokenAt,
  parseMentionLinkpaths,
  splitAttachedNotes,
  type NoteCandidate,
} from "../src/context";

describe("buildPromptWithNotes", () => {
  it("returns the text unchanged without notes", () => {
    expect(buildPromptWithNotes("Just a question.", [])).toBe("Just a question.");
  });

  it("prepends a block listing every note with its path and content", () => {
    const prompt = buildPromptWithNotes("Compare these.", [
      { path: "00-Inbox/First.md", content: "first body" },
      { path: "02-Projects/Second.md", content: "second body" },
    ]);

    expect(prompt).toContain('<bolovan-note path="00-Inbox/First.md">');
    expect(prompt).toContain("first body");
    expect(prompt).toContain('<bolovan-note path="02-Projects/Second.md">');
    expect(prompt).toContain("second body");
    expect(prompt.trimEnd().endsWith("Compare these.")).toBe(true);
  });

  it("truncates oversized notes with a marker", () => {
    const content = "x".repeat(MAX_ATTACHMENT_CHARS + 500);
    const prompt = buildPromptWithNotes("Read it.", [{ path: "Big.md", content }]);

    expect(prompt).toContain("[truncated by Bolovan]");
    expect(prompt).not.toContain("x".repeat(MAX_ATTACHMENT_CHARS + 1));
  });
});

describe("splitAttachedNotes", () => {
  it("passes prompts without a block through unchanged", () => {
    expect(splitAttachedNotes("plain question")).toEqual({
      text: "plain question",
      paths: [],
    });
  });

  it("round-trips buildPromptWithNotes", () => {
    const prompt = buildPromptWithNotes("What changed?", [
      { path: "Journal/Today.md", content: "entries" },
      { path: "Projects/Bolovan.md", content: "notes" },
    ]);

    expect(splitAttachedNotes(prompt)).toEqual({
      text: "What changed?",
      paths: ["Journal/Today.md", "Projects/Bolovan.md"],
    });
  });

  it("round-trips multiline messages", () => {
    const prompt = buildPromptWithNotes("Line one.\n\nLine two.", [
      { path: "A.md", content: "a" },
    ]);

    expect(splitAttachedNotes(prompt).text).toBe("Line one.\n\nLine two.");
  });
});

describe("parseMentionLinkpaths", () => {
  it("extracts a plain mention", () => {
    expect(parseMentionLinkpaths("See @[[Today]] please")).toEqual(["Today"]);
  });

  it("keeps folders, strips headings and aliases", () => {
    expect(parseMentionLinkpaths("@[[01-Journal/Today#Morning|alias]]")).toEqual([
      "01-Journal/Today",
    ]);
  });

  it("collects several mentions in order", () => {
    expect(parseMentionLinkpaths("@[[One]] and @[[Two]] and @[[Three]]")).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });

  it("ignores links without the @ marker", () => {
    expect(parseMentionLinkpaths("plain [[Link]] and email@site.com")).toEqual([]);
  });
});

describe("matchNoteCandidates", () => {
  const notes: NoteCandidate[] = [
    { path: "01-Journaling/Journal Today.md", basename: "Journal Today" },
    { path: "00-Inbox/Today.md", basename: "Today" },
    { path: "04-Resources/Plan.md", basename: "Plan" },
    { path: "02-Projects/Bolovan Plan.md", basename: "Bolovan Plan" },
  ];

  it("ranks exact, prefix, name-substring, then path-substring matches", () => {
    const matches = matchNoteCandidates(notes, "today");
    expect(matches.map((note) => note.basename)).toEqual(["Today", "Journal Today"]);
  });

  it("falls back to the path for folder queries", () => {
    const matches = matchNoteCandidates(notes, "02-projects");
    expect(matches.map((note) => note.basename)).toEqual(["Bolovan Plan"]);
  });

  it("keeps the caller's order and honors the limit for empty queries", () => {
    const matches = matchNoteCandidates(notes, "", 2);
    expect(matches.map((note) => note.basename)).toEqual(["Journal Today", "Today"]);
  });

  it("drops non-matches", () => {
    expect(matchNoteCandidates(notes, "zzz")).toEqual([]);
  });
});

describe("mentionTokenAt", () => {
  it("finds the token starting at the last @ before the caret", () => {
    expect(mentionTokenAt("see @jou", 8)).toEqual({ start: 4, end: 8, query: "jou" });
  });

  it("accepts an empty query right after @", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("requires @ to start at a token boundary", () => {
    expect(mentionTokenAt("email@site", 10)).toBeUndefined();
  });

  it("ignores completed mentions with brackets", () => {
    expect(mentionTokenAt("@[[Note]] ", 10)).toBeUndefined();
  });

  it("stops at newlines", () => {
    expect(mentionTokenAt("@a\nb", 4)).toBeUndefined();
  });
});

describe("mentionLabel", () => {
  const unique = { path: "00-Inbox/Today.md", basename: "Today" };
  const duplicated = { path: "01-Journal/Today.md", basename: "Today" };

  it("uses the basename when it is unique", () => {
    expect(mentionLabel(unique, [unique])).toBe("Today");
  });

  it("falls back to the linkpath when the basename is ambiguous", () => {
    expect(mentionLabel(duplicated, [unique, duplicated])).toBe("01-Journal/Today");
  });
});
