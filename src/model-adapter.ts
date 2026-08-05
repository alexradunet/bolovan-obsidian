import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export type ThinkingEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderConfig {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  thinkingEffort?: ThinkingEffort;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ModelReply {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelAdapter {
  complete(messages: ModelMessage[], tools: readonly ToolDefinition[], signal: AbortSignal): Promise<ModelReply>;
}

export type RequestTransport = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

export function createModelAdapter(
  config: ProviderConfig,
  requestTransport: RequestTransport,
): ModelAdapter {
  return new OpenAiCompatibleAdapter(config, requestTransport);
}

/** Lists model ids from the endpoint's /models route, sorted alphabetically. */
export async function fetchModelList(
  config: { baseUrl?: string; apiKey?: string },
  requestTransport: RequestTransport,
): Promise<string[]> {
  const endpoint = new OpenAiCompatibleEndpoint(config, requestTransport);
  const response = await endpoint.request("/models", { method: "GET" });
  // Accepts both `{ data: [...] }` and bare-array /models responses.
  const json: unknown = response.json;
  const entries: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === "object" && "data" in json && Array.isArray(json.data)
      ? json.data
      : [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" && entry.id) {
      ids.add(entry.id);
    }
  }
  if (!ids.size) {
    throw new Error("The endpoint returned no models");
  }
  return [...ids].sort();
}

class OpenAiCompatibleAdapter implements ModelAdapter {
  private readonly endpoint: OpenAiCompatibleEndpoint;

  constructor(
    private readonly config: ProviderConfig,
    requestTransport: RequestTransport,
  ) {
    this.endpoint = new OpenAiCompatibleEndpoint(config, requestTransport);
  }

  async complete(
    messages: ModelMessage[],
    tools: readonly ToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelReply> {
    if (signal.aborted) {
      throw abortError();
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: false,
      messages: messages.map(toOpenAiMessage),
      tools: tools.map((tool) => ({ type: "function", function: tool })),
      tool_choice: "auto",
    };
    if (this.config.thinkingEffort && this.config.thinkingEffort !== "none") {
      body.reasoning_effort = this.config.thinkingEffort;
    }

    const response = await this.endpoint.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (signal.aborted) {
      throw abortError();
    }

    const choice = response.json?.choices?.[0]?.message;
    if (!choice) {
      throw new Error("The provider returned no assistant message");
    }
    const toolCalls = Array.isArray(choice.tool_calls)
      ? choice.tool_calls.map((value: unknown, index: number) => {
          const call = objectOrEmpty(value);
          const fn = objectOrEmpty(call.function);
          return {
            id: String(call.id ?? `call-${index}`),
            name: String(fn.name ?? "unknown"),
            arguments: parseArguments(fn.arguments),
          };
        })
      : [];
    const usage = response.json?.usage;
    return {
      text: typeof choice.content === "string" ? choice.content : "",
      toolCalls,
      usage: usage ? {
        inputTokens: numberOrUndefined(usage.prompt_tokens),
        outputTokens: numberOrUndefined(usage.completion_tokens),
        totalTokens: numberOrUndefined(usage.total_tokens),
      } : undefined,
    };
  }
}

interface EndpointRequest {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/** Shared request policy for one configured OpenAI-compatible model endpoint. */
class OpenAiCompatibleEndpoint {
  private readonly baseUrl: string;
  private readonly authorization: string | undefined;

  constructor(
    config: { baseUrl?: string; apiKey?: string },
    private readonly requestTransport: RequestTransport,
  ) {
    this.baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.authorization = config.apiKey ? `Bearer ${config.apiKey}` : undefined;
  }

  async request(path: string, request: EndpointRequest): Promise<RequestUrlResponse> {
    const headers = { ...request.headers };
    if (this.authorization) {
      headers.Authorization = this.authorization;
    }
    const response = await this.requestTransport({
      url: `${this.baseUrl}${path}`,
      method: request.method,
      headers,
      body: request.body,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(openAiError(response));
    }
    return response;
  }
}

function toOpenAiMessage(message: ModelMessage): Record<string, unknown> {
  const result: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCallId) {
    result.tool_call_id = message.toolCallId;
  }
  if (message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return result;
}


function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return objectOrEmpty(value);
  }
  try {
    return objectOrEmpty(JSON.parse(value));
  } catch {
    return {};
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function openAiError(response: RequestUrlResponse): string {
  const detail = response.json?.error?.message ?? response.text?.slice(0, 500) ?? "Unknown error";
  return `Provider request failed (${response.status}): ${detail}`;
}

function abortError(): DOMException {
  return new DOMException("The response was stopped", "AbortError");
}
