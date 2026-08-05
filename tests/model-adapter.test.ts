import { describe, expect, it } from "vitest";
import { createModelAdapter, fetchModelList, type RequestTransport } from "../src/model-adapter";

function parseBody(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  if (!isRecord(parsed)) {
    throw new Error("Expected an object request body");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

describe("OpenAI-compatible model adapter", () => {
  it("normalizes assistant text, tool calls, and usage", async () => {
    let request: Parameters<RequestTransport>[0] | undefined;
    let body: Record<string, unknown> = {};
    const transport: RequestTransport = async (sent) => {
      request = sent;
      body = parseBody(sent.body);
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
      { model: "test-model", apiKey: "secret", thinkingEffort: "high" },
      transport,
    );

    const reply = await adapter.complete(
      [{ role: "user", content: "Read Note.md" }],
      [{ name: "vault_read", description: "Read", parameters: { type: "object" } }],
      new AbortController().signal,
    );

    expect(request).toMatchObject({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
      },
      throw: false,
    });
    expect(body).toMatchObject({
      model: "test-model",
      stream: false,
      reasoning_effort: "high",
      tools: [{ function: { name: "vault_read" } }],
    });
    expect(reply).toMatchObject({
      text: "I will read it.",
      toolCalls: [{ id: "call-1", name: "vault_read", arguments: { path: "Note.md" } }],
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it("omits disabled thinking for generic compatible endpoints", async () => {
    let body: Record<string, unknown> = {};
    const transport: RequestTransport = async (request) => {
      body = parseBody(request.body);
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: { choices: [{ message: { content: "ok" } }] },
      };
    };
    const adapter = createModelAdapter(
      { model: "local", thinkingEffort: "none" },
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
      { model: "model", baseUrl: "https://local.test/v1" },
      transport,
    );

    await expect(adapter.complete([], [], new AbortController().signal))
      .rejects.toThrow("Provider request failed (401): Invalid API key");
  });
});

describe("model list query", () => {
  it("lists, dedupes, and sorts model ids from a data envelope", async () => {
    let request: Parameters<RequestTransport>[0] | undefined;
    const transport: RequestTransport = async (req) => {
      request = req;
      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: { data: [{ id: "zeta" }, { id: "alpha" }, { id: "zeta" }, { other: true }] },
      };
    };

    const models = await fetchModelList(
      { baseUrl: "https://local.test/v1/", apiKey: "secret" },
      transport,
    );

    expect(request?.url).toBe("https://local.test/v1/models");
    expect(request?.headers?.Authorization).toBe("Bearer secret");
    expect(models).toEqual(["alpha", "zeta"]);
  });

  it("accepts a bare array response", async () => {
    const transport: RequestTransport = async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: [{ id: "only" }],
    });

    await expect(fetchModelList({ baseUrl: "https://local.test/v1" }, transport))
      .resolves.toEqual(["only"]);
  });

  it("surfaces endpoint failures", async () => {
    const transport: RequestTransport = async () => ({
      status: 401,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: { error: { message: "Invalid API key" } },
    });

    await expect(fetchModelList({}, transport))
      .rejects.toThrow("Provider request failed (401): Invalid API key");
  });

  it("rejects an empty model list", async () => {
    const transport: RequestTransport = async () => ({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "",
      json: { data: [] },
    });

    await expect(fetchModelList({}, transport))
      .rejects.toThrow("The endpoint returned no models");
  });
});
