import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type AgentSession,
  type AgentSessionEvent,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROVIDER_ID = "nazar-local";
const TOOL_NAME = "vault_read";

export interface NazarAgentOptions {
  baseUrl: string;
  modelId: string;
  readNote(path: string): Promise<string>;
}

export type NazarEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean };

export interface NazarAgentStatus {
  modelId: string;
  activeTools: string[];
  isRunning: boolean;
}

export class NazarAgent {
  private constructor(private readonly session: AgentSession) {}

  static async create(options: NazarAgentOptions): Promise<NazarAgent> {
    const modelRuntime = await createModelRuntime(options);
    const model = modelRuntime.getModel(PROVIDER_ID, options.modelId);
    if (!model) {
      throw new Error(`Local model was not registered: ${options.modelId}`);
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: [
        "You are Nazar, a local Obsidian vault assistant.",
        "Use vault_read when note contents are needed.",
        "Never claim to have read a note unless the tool returned it.",
      ].join("\n"),
    });
    await resourceLoader.reload();

    const vaultReadTool = defineTool({
      name: TOOL_NAME,
      label: "Read note",
      description: "Read one visible Markdown note from the Obsidian vault by path.",
      promptSnippet: "Read a visible Markdown note by vault-relative path.",
      parameters: Type.Object({
        path: Type.String({ description: "Vault-relative Markdown path" }),
      }),
      execute: async (_toolCallId, params) => {
        try {
          const content = await options.readNote(params.path);
          return {
            content: [{ type: "text", text: content }],
            details: { path: params.path },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Unable to read ${params.path}: ${message}` }],
            details: { path: params.path },
            isError: true,
          };
        }
      },
    });

    const { session } = await createAgentSession({
      model,
      modelRuntime,
      thinkingLevel: "off",
      tools: [TOOL_NAME],
      customTools: [vaultReadTool],
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    });

    return new NazarAgent(session);
  }

  status(): NazarAgentStatus {
    return {
      modelId: this.session.model?.id ?? "unavailable",
      activeTools: this.session.getActiveToolNames(),
      isRunning: this.session.isStreaming,
    };
  }

  async ask(prompt: string, onEvent: (event: NazarEvent) => void): Promise<void> {
    if (this.session.isStreaming) {
      throw new Error("Nazar is already running");
    }

    const unsubscribe = this.session.subscribe((event) => {
      const nazarEvent = toNazarEvent(event);
      if (nazarEvent) {
        onEvent(nazarEvent);
      }
    });

    try {
      await this.session.prompt(prompt, { expandPromptTemplates: false });
    } finally {
      unsubscribe();
    }
  }

  async cancel(): Promise<void> {
    await this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }
}

async function createModelRuntime(options: NazarAgentOptions): Promise<ModelRuntime> {
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });

  modelRuntime.registerProvider(PROVIDER_ID, {
    name: "Nazar local llamafile",
    baseUrl: options.baseUrl,
    api: "openai-completions",
    apiKey: "local-only",
    models: [
      {
        id: options.modelId,
        name: options.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 4_096,
        compat: {
          supportsDeveloperRole: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey(PROVIDER_ID, "local-only");

  return modelRuntime;
}

function toNazarEvent(event: AgentSessionEvent): NazarEvent | undefined {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return { type: "text", delta: event.assistantMessageEvent.delta };
  }

  if (event.type === "tool_execution_start") {
    return { type: "tool-start", name: event.toolName };
  }

  if (event.type === "tool_execution_end") {
    return { type: "tool-end", name: event.toolName, isError: event.isError };
  }

  return undefined;
}
