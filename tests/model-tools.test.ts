import { describe, expect, it } from "vitest";

import { ModelTools } from "../src/model-tools";
import { fakeApp } from "./fake-app";

const TOOL_NAMES = [
  "vault_read",
  "vault_search",
  "vault_list",
  "vault_inspect",
  "vault_change",
  "workspace",
  "web_read",
];

describe("ModelTools", () => {
  it("keeps every advertised definition connected to an invocation", async () => {
    const tools = new ModelTools(fakeApp(), async () => {
      throw new Error("A missing web URL must not reach the transport");
    });
    const signal = new AbortController().signal;

    expect(tools.definitions.map((definition) => definition.name)).toEqual(TOOL_NAMES);
    for (const name of TOOL_NAMES) {
      const result = await tools.execute(name, {}, signal);
      expect(result).toHaveProperty("content");
      expect("content" in result && result.content).not.toContain("Unknown tool");
    }
  });

  it("normalizes invocation errors and preserves cancellation", async () => {
    const tools = new ModelTools(fakeApp(), async () => {
      throw new Error("unused");
    });
    const signal = new AbortController().signal;

    await expect(tools.execute("workspace", { action: "unsupported" }, signal)).resolves.toEqual({
      content: "Unsupported workspace action: unsupported",
      isError: true,
    });
    await expect(tools.execute("missing", {}, signal)).resolves.toEqual({
      content: "Unknown tool: missing",
      isError: true,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(tools.execute("workspace", { action: "context" }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
