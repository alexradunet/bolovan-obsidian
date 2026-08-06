import type { App } from "obsidian";
import type { RequestTransport, ToolDefinition } from "./model-adapter";
import { createVaultModelTools } from "./vault-tools";
import { createWebModelTool } from "./web-content";
import type { ActivatedSkill } from "./skills";
import { createWorkspaceModelTool } from "./workspace-tools";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface PreparedChange {
  title: string;
  message: string;
  diff?: {
    before: string;
    after: string;
  };
  apply(): Promise<ToolResult>;
}

export type ToolOutcome = ToolResult | PreparedChange;

export interface ModelTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface SkillAccess {
  activateSkill(name: string): Promise<ActivatedSkill>;
  readSkillResource(name: string, path: string): Promise<string>;
}

/** The model-facing tool interface: definitions and invocation stay together. */
export class ModelTools {
  readonly definitions: readonly ToolDefinition[];
  private readonly tools: ReadonlyMap<string, ModelTool>;

  constructor(app: App, requestTransport: RequestTransport, skillAccess?: SkillAccess) {
    const tools: ModelTool[] = [
      ...createVaultModelTools(app),
      createWorkspaceModelTool(app),
      createWebModelTool(requestTransport),
      ...(skillAccess ? [createSkillModelTool(skillAccess)] : []),
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

function createSkillModelTool(skills: SkillAccess): ModelTool {
  return {
    definition: {
      name: "skill_read",
      description: "Activate a cataloged Agent Skill or read one bounded resource inside an activated skill package. This never executes scripts or grants tools.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["activate", "resource"] },
          name: { type: "string", description: "Exact cataloged skill name" },
          path: { type: "string", description: "Relative resource path required for resource" },
        },
        required: ["action", "name"],
      },
    },
    async execute(args) {
      if (typeof args.name !== "string" || !args.name) {
        throw new Error("name must be a non-empty string");
      }
      if (args.action === "activate") {
        return { content: JSON.stringify(await skills.activateSkill(args.name)) };
      }
      if (args.action === "resource") {
        if (typeof args.path !== "string" || !args.path) {
          throw new Error("path must be a non-empty string");
        }
        return {
          content: JSON.stringify({
            name: args.name,
            path: args.path,
            content: await skills.readSkillResource(args.name, args.path),
          }),
        };
      }
      throw new Error(`Unsupported skill_read action: ${String(args.action)}`);
    },
  };
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
