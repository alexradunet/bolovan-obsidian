import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { loadWebGpuRuntime, type LocalRuntime } from "./webgpu-runtime";

export type ProviderKind = "openai" | "openai-compatible" | "webgpu";
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
  if (config.kind === "webgpu") {
    return new WebGpuModelAdapter(config.model);
  }
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

/**
 * Transformers.js stays behind this adapter and is loaded only when the user
 * selects a local model. There is deliberately no WASM/CPU fallback: a device
 * without WebGPU must use a remote provider.
 */
class WebGpuModelAdapter implements ModelAdapter {
  private runtime: Promise<LocalRuntime> | undefined;

  constructor(private readonly modelId: string) {}

  async complete(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelReply> {
    if (!("gpu" in navigator)) {
      throw new Error("WebGPU is unavailable on this device. Select a remote provider.");
    }
    if (!this.runtime) {
      const gpuAdapter = await (navigator as any).gpu.requestAdapter();
      if (!gpuAdapter) {
        throw new Error("No compatible WebGPU adapter is available. Select a remote provider.");
      }
    }
    if (signal.aborted) {
      throw abortError();
    }
    const runtime = await (this.runtime ??= loadWebGpuRuntime(this.modelId));
    const localMessages = messages.map((message) => ({
      role: message.role,
      content: message.content + (message.toolCalls?.length
        ? `\n<bolovan-tool-calls>${JSON.stringify(message.toolCalls)}</bolovan-tool-calls>`
        : ""),
    }));
    const toolProtocol = localToolProtocol(tools);
    if (localMessages[0]?.role === "system") {
      localMessages[0].content = `${localMessages[0].content}\n\n${toolProtocol}`;
    } else {
      localMessages.unshift({ role: "system", content: toolProtocol });
    }
    const inputs = await runtime.processor.apply_chat_template(localMessages, {
      add_generation_prompt: true,
      tokenize: true,
      return_dict: true,
    });
    const output = await runtime.model.generate({
      ...inputs,
      max_new_tokens: 1024,
      do_sample: false,
    });
    if (signal.aborted) {
      throw abortError();
    }
    const promptLength = Number(inputs.input_ids?.dims?.at(-1) ?? 0);
    const generated = output.slice?.(null, [promptLength, null]) ?? output;
    const decoded = await runtime.processor.batch_decode(generated, { skip_special_tokens: true });
    return parseLocalReply(String(decoded?.[0] ?? ""));
  }

  dispose(): void {
    void this.runtime?.then(({ model }) => model.dispose?.());
    this.runtime = undefined;
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

function localToolProtocol(tools: ToolDefinition[]): string {
  return [
    "You may use Bolovan vault tools. To call tools, reply with only this JSON:",
    '{"tool_calls":[{"name":"vault_read","arguments":{"path":"Note.md"}}]}',
    "After tool results, answer normally or issue another tool call. Never invent tool results.",
    `Available tools: ${JSON.stringify(tools)}`,
  ].join("\n");
}

function parseLocalReply(text: string): ModelReply {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed?.tool_calls)) {
      return {
        text: "",
        toolCalls: parsed.tool_calls.map((call: any, index: number) => ({
          id: `local-${Date.now()}-${index}`,
          name: String(call?.name ?? "unknown"),
          arguments: objectOrEmpty(call?.arguments),
        })),
      };
    }
  } catch {
    // A normal assistant response is not JSON.
  }
  return { text, toolCalls: [] };
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
