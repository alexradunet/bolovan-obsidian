import type { RequestUrlParam, RequestUrlResponse } from "obsidian";

export type ProviderKind = "openai" | "openai-compatible";
export type ThinkingEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderConfig {
  kind: ProviderKind;
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
  complete(messages: ModelMessage[], tools: ToolDefinition[], signal: AbortSignal): Promise<ModelReply>;
  dispose?(): void;
}

export type RequestTransport = (request: RequestUrlParam) => Promise<RequestUrlResponse>;

export function createModelAdapter(
  config: ProviderConfig,
  requestTransport: RequestTransport,
): ModelAdapter {
  return new OpenAiCompatibleAdapter(config, requestTransport);
}

class OpenAiCompatibleAdapter implements ModelAdapter {
  constructor(
    private readonly config: ProviderConfig,
    private readonly requestTransport: RequestTransport,
  ) {}

  async complete(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelReply> {
    if (signal.aborted) {
      throw abortError();
    }
    const baseUrl = (this.config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: false,
      messages: messages.map(toOpenAiMessage),
      tools: tools.map((tool) => ({ type: "function", function: tool })),
      tool_choice: "auto",
    };
    if (this.config.thinkingEffort &&
        (this.config.kind === "openai" || this.config.thinkingEffort !== "none")) {
      body.reasoning_effort = this.config.thinkingEffort;
    }

    const response = await this.requestTransport({
      url: `${baseUrl}/chat/completions`,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
    if (signal.aborted) {
      throw abortError();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(openAiError(response));
    }

    const choice = response.json?.choices?.[0]?.message;
    if (!choice) {
      throw new Error("The provider returned no assistant message");
    }
    const toolCalls = Array.isArray(choice.tool_calls)
      ? choice.tool_calls.map((call: any, index: number) => ({
          id: String(call?.id ?? `call-${index}`),
          name: String(call?.function?.name ?? "unknown"),
          arguments: parseArguments(call?.function?.arguments),
        }))
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
