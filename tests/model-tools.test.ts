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

  it("activates skills and reads resources through the bounded tool interface", async () => {
    const tools = new ModelTools(
      fakeApp(),
      async () => {
        throw new Error("unused");
      },
      {
        activateSkill: async (name) => ({
          name,
          description: "Review work",
          instructions: "Check observed behavior.",
          resources: ["references/checklist.md"],
        }),
        readSkillResource: async (_name, path) => `resource:${path}`,
      },
    );
    const signal = new AbortController().signal;

    expect(tools.definitions.map((definition) => definition.name)).toContain("skill_read");
    await expect(tools.execute("skill_read", {
      action: "activate",
      name: "code-review",
    }, signal)).resolves.toMatchObject({
      content: expect.stringContaining("Check observed behavior."),
    });
    await expect(tools.execute("skill_read", {
      action: "resource",
      name: "code-review",
      path: "references/checklist.md",
    }, signal)).resolves.toMatchObject({
      content: expect.stringContaining("resource:references/checklist.md"),
    });
  });
});
