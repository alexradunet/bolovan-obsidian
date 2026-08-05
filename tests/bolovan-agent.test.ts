import type { RequestUrlResponse } from "obsidian";
import { describe, expect, it } from "vitest";

import { BolovanAgent, type BolovanEvent } from "../src/bolovan-agent";
import type { RequestTransport } from "../src/model-adapter";
import { fakeApp } from "./fake-app";


describe("BolovanAgent cancellation", () => {
  it("ignores a provider response that arrives after cancellation", async () => {
    let requestStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let releaseResponse: (response: RequestUrlResponse) => void = () => undefined;
    const pendingResponse = new Promise<RequestUrlResponse>((resolve) => {
      releaseResponse = resolve;
    });
    const transport: RequestTransport = async () => {
      requestStarted();
      return pendingResponse;
    };
    const agent = new BolovanAgent({
      app: fakeApp(),
      brainFolder: "Brain",
      deviceId: "local",
      provider: () => ({ model: "test-model" }),
      requestTransport: transport,
    });
    const events: BolovanEvent[] = [];
    agent.subscribe((event) => events.push(event));

    const run = agent.ask("hello");
    await started;
    await agent.cancel();
    releaseResponse({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: { choices: [{ message: { content: "late answer" } }] },
    });
    await run;

    expect(await agent.getMessages()).toEqual([{ role: "user", content: "hello" }]);
    expect(events).toEqual([{ type: "settled" }]);
    expect(agent.status().isRunning).toBe(false);
  });

  it("rejects a pending change approval when cancelled", async () => {
    let requestCount = 0;
    const transport: RequestTransport = async () => {
      requestCount += 1;
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: {
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "change-1",
                function: {
                  name: "vault_change",
                  arguments: "{\"action\":\"create\",\"path\":\"New.md\",\"content\":\"unsafe\"}",
                },
              }],
            },
          }],
        },
      };
    };
    let approvalRequested: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => {
      approvalRequested = resolve;
    });
    const agent = new BolovanAgent({
      app: fakeApp(),
      brainFolder: "Brain",
      deviceId: "local",
      provider: () => ({ model: "test-model" }),
      requestTransport: transport,
    });
    agent.setApprovalResponder(() => approvalRequested());

    const run = agent.ask("create a note");
    await requested;
    await agent.cancel();
    await run;

    expect(requestCount).toBe(1);
    expect(await agent.getMessages()).not.toContainEqual(
      expect.objectContaining({ role: "tool" }),
    );
  });
});

describe("BolovanAgent tool loop", () => {
  it("stops a model that keeps requesting tools", async () => {
    let requestCount = 0;
    const transport: RequestTransport = async () => {
      requestCount += 1;
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: {
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: `call-${requestCount}`,
                function: { name: "unknown_tool", arguments: "{}" },
              }],
            },
          }],
        },
      };
    };
    const agent = new BolovanAgent({
      app: fakeApp(),
      brainFolder: "Brain",
      deviceId: "local",
      provider: () => ({ model: "test-model" }),
      requestTransport: transport,
    });
    const events: BolovanEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await expect(agent.ask("loop forever")).rejects.toThrow("stopped after 12 tool rounds");

    expect(requestCount).toBe(12);
    expect(events.at(-1)).toEqual({
      type: "exited",
      message: "Bolovan stopped after 12 tool rounds",
    });
    expect(agent.status().isRunning).toBe(false);
  });
});

describe("BolovanAgent response format", () => {
  it("provides image, Canvas, and Bases workflows", async () => {
    let systemPrompt = "";
    let toolNames: string[] = [];
    const transport: RequestTransport = async (request) => {
      const body = JSON.parse(String(request.body)) as {
        messages: Array<{ role: string; content: string }>;
        tools: Array<{ function: { name: string } }>;
      };
      systemPrompt = body.messages.find((message) => message.role === "system")?.content ?? "";
      toolNames = body.tools.map((tool) => tool.function.name);
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: { choices: [{ message: { content: "done" } }] },
      };
    };
    const agent = new BolovanAgent({
      app: fakeApp(),
      brainFolder: "Brain",
      deviceId: "local",
      provider: () => ({ model: "test-model" }),
      requestTransport: transport,
    });

    await agent.ask("show me an image");

    expect(systemPrompt).toContain("![alt](URL)");
    expect(systemPrompt).toContain("![[vault/path.png]]");
    expect(systemPrompt).toContain("Prefer vault_change patch");
    expect(systemPrompt).toContain("Open a vault file only when the user asks to navigate");
    expect(systemPrompt).toContain("Groups contain nodes by geometry");
    expect(systemPrompt).toContain("global and view filters combine with AND");
    expect(systemPrompt).toContain("For a one-off prompt filter, use vault_search without changing a Base");
    expect(systemPrompt).toContain("vault_search does not evaluate Bases formulas");
    expect(toolNames).toEqual(expect.arrayContaining(["vault_inspect", "workspace"]));
  });
});

describe("BolovanAgent self-developed skills", () => {
  it("loads an approved skill on the next model round", async () => {
    const app = fakeApp();
    const systemPrompts: string[] = [];
    const skillContent = [
      "# Reusable review",
      "",
      "## When to use",
      "Use after completing a review.",
      "",
      "## Procedure",
      "1. Read the subject.",
      "2. Report concrete findings.",
      "",
      "## Pitfalls",
      "- Do not guess.",
      "",
      "## Verification",
      "Confirm every finding cites observed content.",
    ].join("\n");
    let requestCount = 0;
    const transport: RequestTransport = async (request) => {
      requestCount += 1;
      const body = JSON.parse(String(request.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      systemPrompts.push(body.messages.find((message) => message.role === "system")?.content ?? "");
      const message = requestCount === 1
        ? {
            content: "",
            tool_calls: [{
              id: "create-skill",
              function: {
                name: "vault_change",
                arguments: JSON.stringify({
                  action: "create",
                  path: "Brain/Skills/reusable-review.md",
                  content: skillContent,
                }),
              },
            }],
          }
        : { content: "Learned the reusable review skill." };
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: { choices: [{ message }] },
      };
    };
    const agent = new BolovanAgent({
      app,
      brainFolder: "Brain",
      deviceId: "local",
      provider: () => ({ model: "test-model" }),
      requestTransport: transport,
    });
    agent.setApprovalResponder((request) => agent.respondApproval(request.id, true));

    await agent.ask("Learn this review procedure for next time.");

    const skill = app.vault.getFileByPath("Brain/Skills/reusable-review.md");
    expect(skill).not.toBeNull();
    expect(await app.vault.cachedRead(skill!)).toBe(skillContent);
    expect(systemPrompts[0]).toContain("Brain/Skills/<kebab-case>.md");
    expect(systemPrompts[0]).toContain("Treat a rewrite as a candidate, not proof");
    expect(systemPrompts[1]).toContain("## Skill: reusable-review");
    expect(systemPrompts[1]).toContain(skillContent);
  });
});
