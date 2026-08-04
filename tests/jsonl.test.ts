import { describe, expect, it } from "vitest";
import { createJsonlReader } from "../src/jsonl";

describe("createJsonlReader", () => {
  it("splits records on LF only", () => {
    const lines: string[] = [];
    const feed = createJsonlReader((line) => lines.push(line));

    feed('{"type":"a"}\n{"type":"b"}\n');

    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("buffers records split across chunks", () => {
    const lines: string[] = [];
    const feed = createJsonlReader((line) => lines.push(line));

    feed('{"type":');
    expect(lines).toEqual([]);

    feed('"a"}\n{"type":"b"}');
    expect(lines).toEqual(['{"type":"a"}']);

    feed("\n");
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it("strips a trailing carriage return from CRLF input", () => {
    const lines: string[] = [];
    const feed = createJsonlReader((line) => lines.push(line));

    feed('{"type":"a"}\r\n');

    expect(lines).toEqual(['{"type":"a"}']);
  });

  it("does not split on Unicode line separators inside records", () => {
    const lines: string[] = [];
    const feed = createJsonlReader((line) => lines.push(line));

    const record = '{"text":"before\\u2028middle\\u2029after"}';
    feed(`${record}\n`);

    expect(lines).toEqual([record]);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.text).toBe("before\u2028middle\u2029after");
  });

  it("skips empty lines", () => {
    const lines: string[] = [];
    const feed = createJsonlReader((line) => lines.push(line));

    feed('{"type":"a"}\n\n\n{"type":"b"}\n');

    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });
});
