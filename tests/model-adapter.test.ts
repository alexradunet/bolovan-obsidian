import { describe, expect, it } from "vitest";
import { createModelAdapter, type RequestTransport } from "../src/model-adapter";

describe("OpenAI-compatible model adapter", () => {
  it("normalizes assistant text, tool calls, and usage", async () => {
    let body: any;
    const transport: RequestTransport = async (request) => {
      body = JSON.parse(String(request.body));
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: {
          choices: [{ message: {
            content: "I will read it.",
            tool_calls: [{
              id: "call-1",
              function: { name: "vault_read", arguments: '{"path":"Note.md"}' },
            }],
          } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      };
    };
    const adapter = createModelAdapter(
      { kind: "openai", model: "test-model", apiKey: "secret", thinkingEffort: "high" },
      transport,
    );

    const reply = await adapter.complete(
      [{ role: "user", content: "Read Note.md" }],
      [{ name: "vault_read", description: "Read", parameters: { type: "object" } }],
      new AbortController().signal,
    );

    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(false);
    expect(body.reasoning_effort).toBe("high");
    expect(body.tools[0].function.name).toBe("vault_read");
    expect(reply).toMatchObject({
      text: "I will read it.",
      toolCalls: [{ id: "call-1", name: "vault_read", arguments: { path: "Note.md" } }],
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it("omits disabled thinking for generic compatible endpoints", async () => {
    let body: any;
    const transport: RequestTransport = async (request) => {
      body = JSON.parse(String(request.body));
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: { choices: [{ message: { content: "ok" } }] },
      };
    };
    const adapter = createModelAdapter(
      { kind: "openai-compatible", model: "local", thinkingEffort: "none" },
      transport,
    );

    await adapter.complete([], [], new AbortController().signal);

    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("surfaces provider failures without leaking request data", async () => {
    const transport: RequestTransport = async () => ({
      status: 401,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "unauthorized",
      json: { error: { message: "Invalid API key" } },
    });
    const adapter = createModelAdapter(
      { kind: "openai-compatible", model: "model", baseUrl: "https://local.test/v1" },
      transport,
    );

    await expect(adapter.complete([], [], new AbortController().signal))
      .rejects.toThrow("Provider request failed (401): Invalid API key");
  });
});
