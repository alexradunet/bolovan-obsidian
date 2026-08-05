import type { App } from "obsidian";
import type { RequestTransport, ToolDefinition } from "./model-adapter";
import { createVaultModelTools } from "./vault-tools";
import { createWebModelTool } from "./web-content";
import { createWorkspaceModelTool } from "./workspace-tools";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface PreparedChange {
  title: string;
  message: string;
  apply(): Promise<ToolResult>;
}

export type ToolOutcome = ToolResult | PreparedChange;

export interface ModelTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

/** The model-facing tool interface: definitions and invocation stay together. */
export class ModelTools {
  readonly definitions: readonly ToolDefinition[];
  private readonly tools: ReadonlyMap<string, ModelTool>;

  constructor(app: App, requestTransport: RequestTransport) {
    const tools: ModelTool[] = [
      ...createVaultModelTools(app),
      createWorkspaceModelTool(app),
      createWebModelTool(requestTransport),
    ];
    this.definitions = tools.map((tool) => tool.definition);
    this.tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }
    try {
      throwIfAborted(signal);
      const result = await tool.execute(args, signal);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (signal.aborted || isAbort(error)) {
        throw abortError();
      }
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The response was stopped", "AbortError");
}
