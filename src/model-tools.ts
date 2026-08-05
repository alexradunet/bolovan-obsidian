import type { App } from "obsidian";
import type { RequestTransport, ToolDefinition } from "./model-adapter";
import { VaultTools, VAULT_TOOL_DEFINITIONS } from "./vault-tools";
import { WebContentReader, WEB_TOOL_DEFINITION } from "./web-content";
import { WorkspaceTools, WORKSPACE_TOOL_DEFINITION } from "./workspace-tools";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface PreparedChange {
  title: string;
  message: string;
  apply(): Promise<ToolResult>;
}

type ToolOutcome = ToolResult | PreparedChange;

interface ModelTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

/** The model-facing tool interface: definitions and invocation stay together. */
export class ModelTools {
  readonly definitions: readonly ToolDefinition[];
  private readonly tools: ReadonlyMap<string, ModelTool>;

  constructor(app: App, requestTransport: RequestTransport) {
    const vault = new VaultTools(app);
    const workspace = new WorkspaceTools(app);
    const web = new WebContentReader(requestTransport);
    const tools: ModelTool[] = [
      ...VAULT_TOOL_DEFINITIONS.map((definition) => ({
        definition,
        execute: (args: Record<string, unknown>, signal: AbortSignal) => vault.execute(definition.name, args, signal),
      })),
      {
        definition: WORKSPACE_TOOL_DEFINITION,
        execute: (args) => workspace.execute(args),
      },
      {
        definition: WEB_TOOL_DEFINITION,
        execute: (args, signal) => web.read(args.url, signal),
      },
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
