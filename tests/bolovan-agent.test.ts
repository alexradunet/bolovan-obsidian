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
