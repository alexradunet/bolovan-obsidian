import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiTransport, type RpcResponse } from "./pi-transport";

export interface NazarAgentOptions {
  /** Vault root; the spawned pi process runs with this cwd. */
  cwd: string;
  /**
   * Absolute path to the pi binary, or a getter for it; falls back to PATH
   * lookup and install-location probing. Read at spawn time, so setting
   * changes apply the next time pi starts.
   */
  piPath?: string | (() => string | undefined);
  /** Session file tracked from a previous run; absent means a fresh session. */
  sessionFile?: string;
  /** Extra environment variables, merged over the inherited environment. */
  env?: Record<string, string>;
  /** Called whenever the resolved session file path changes. */
  onSessionFile?(sessionFile: string): void;
}

export type NazarEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; name: string; args: Record<string, unknown> }
  | { type: "tool-end"; name: string; isError: boolean }
  | { type: "settled" }
  | { type: "exited"; message: string }
  | { type: "ui-request"; request: NazarUiRequest }
  | { type: "notify"; message: string; notifyType: string };

/** Dialog requests from pi extensions (e.g. the write-approval gate). */
export interface NazarUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface NazarAgentStatus {
  isRunning: boolean;
  sessionFile: string | undefined;
}

export interface NazarModelState {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  sessionFile: string | undefined;
  messageCount: number;
  isStreaming: boolean;
}

export interface NazarModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface NazarSessionSummary {
  path: string;
  modifiedMs: number;
  label: string;
}

/**
 * The vault session façade over one pi process. Owns everything with
 * meaning — runs, session lineage, dialog routing, the command wrappers —
 * and delegates the process and protocol to PiTransport.
 */
export class NazarAgent {
  private readonly transport: PiTransport;
  private listeners = new Set<(event: NazarEvent) => void>();
  private uiResponder: ((request: NazarUiRequest) => void) | undefined;
  private runController: ReturnType<typeof createRunController> | undefined;
  private running = false;
  private sessionFile: string | undefined;

  private constructor(private readonly options: NazarAgentOptions) {
    const tracked = options.sessionFile;
    this.sessionFile = tracked && existsSync(tracked) ? tracked : undefined;

    this.transport = new PiTransport({
      cwd: options.cwd,
      piPath: options.piPath,
      env: options.env,
    });
    this.transport.subscribe((record) => this.handleRecord(record));
  }

  static create(options: NazarAgentOptions): NazarAgent {
    return new NazarAgent(options);
  }

  subscribe(listener: (event: NazarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The chat view registers itself as the dialog surface for extension UI
   * requests. Without a responder, dialog requests are cancelled at once so
   * the agent never blocks on an invisible prompt.
   */
  setUiResponder(responder: ((request: NazarUiRequest) => void) | undefined): void {
    this.uiResponder = responder;
  }

  /** Answer an extension UI dialog request. */
  respondUi(id: string, payload: Record<string, unknown>): void {
    this.transport.send({ type: "extension_ui_response", id, ...payload });
  }

  status(): NazarAgentStatus {
    return { isRunning: this.running, sessionFile: this.sessionFile };
  }

  started(): boolean {
    return this.transport.started();
  }

  /** Spawn the pi process and complete the startup handshake. Idempotent. */
  async start(): Promise<NazarModelState> {
    const state = await this.transport.start({ sessionFile: this.sessionFile });
    this.trackSessionFile(state?.sessionFile);
    return toModelState(state);
  }

  async ask(prompt: string): Promise<void> {
    if (this.running) {
      throw new Error("Nazar is already running");
    }
    await this.start();

    this.running = true;
    const run = createRunController();
    this.runController = run;

    try {
      await this.command({ type: "prompt", message: prompt });
      await run.outcome;
      if (!this.sessionFile) {
        // Fresh sessions only get a file once something happened; ask again.
        const state = await this.getState();
        this.trackSessionFile(state.sessionFile);
      }
    } finally {
      this.runController = undefined;
      this.running = false;
    }
  }

  /** Queue a steering message while a run is active. */
  async steer(message: string): Promise<void> {
    await this.command({ type: "steer", message });
  }

  async cancel(): Promise<void> {
    if (!this.started() || !this.running) {
      return;
    }
    this.transport.abort();
  }

  /** Kill the process; the agent can be started again. */
  stop(): void {
    this.running = false;
    this.runController?.fail(new Error("Nazar stopped"));
    this.runController = undefined;
    this.transport.stop();
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  async getState(): Promise<NazarModelState> {
    const response = await this.command({ type: "get_state" });
    return toModelState(response.data ?? {});
  }

  async getMessages(): Promise<any[]> {
    const response = await this.command({ type: "get_messages" });
    return response.data?.messages ?? [];
  }

  async getStats(): Promise<any> {
    const response = await this.command({ type: "get_session_stats" });
    return response.data ?? {};
  }

  async listModels(): Promise<NazarModelInfo[]> {
    const response = await this.command({ type: "get_available_models" });
    const models = response.data?.models ?? [];
    return models.map((model: any) => ({
      provider: model.provider ?? "unknown",
      id: model.id ?? "unknown",
      name: model.name ?? model.id ?? "unknown",
    }));
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.command({ type: "set_model", provider, modelId });
  }

  async listThinkingLevels(): Promise<string[]> {
    const response = await this.command({ type: "get_available_thinking_levels" });
    return response.data?.levels ?? ["off"];
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.command({ type: "set_thinking_level", level });
  }

  /** Start a fresh pi session; returns the new session file once known. */
  async newSession(): Promise<string | undefined> {
    await this.command({ type: "new_session" });
    const state = await this.getState();
    this.trackSessionFile(state.sessionFile);
    return state.sessionFile;
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.command({ type: "switch_session", sessionPath });
    const state = await this.getState();
    this.trackSessionFile(state.sessionFile);
  }

  /** Drop the tracked session lineage; the next start creates a fresh session. */
  resetSession(): void {
    this.sessionFile = undefined;
    this.options.onSessionFile?.("");
  }

  /** Sessions stored for this vault, newest first. */
  listSessions(): NazarSessionSummary[] {
    const dir = join(this.sessionsRoot(), vaultSessionDirName(this.options.cwd));
    if (!existsSync(dir)) {
      return [];
    }

    const summaries: NazarSessionSummary[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }
      const path = join(dir, entry);
      let modifiedMs = 0;
      try {
        modifiedMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      summaries.push({ path, modifiedMs, label: sessionLabel(entry) });
    }

    return summaries.sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  private async command(command: Record<string, unknown>): Promise<RpcResponse> {
    return this.transport.command(command);
  }

  private handleRecord(record: any): void {
    if (record?.type === "transport_exited") {
      const error = new Error(record.message);
      this.runController?.fail(error);
      this.runController = undefined;
      this.running = false;
      this.emit({ type: "exited", message: record.message });
      return;
    }

    if (record?.type === "extension_ui_request" && typeof record.id === "string") {
      if (record.method === "notify") {
        this.emit({
          type: "notify",
          message: String(record.message ?? ""),
          notifyType: String(record.notifyType ?? "info"),
        });
        return;
      }
      this.handleUiRequest(record);
      return;
    }

    const event = toNazarEvent(record);
    if (event) {
      this.emit(event);
    }
  }

  private handleUiRequest(record: any): void {
    const dialogMethods = ["select", "confirm", "input", "editor"];
    if (!dialogMethods.includes(record.method)) {
      return;
    }

    const request: NazarUiRequest = {
      id: record.id,
      method: record.method,
      title: record.title,
      message: record.message,
      options: record.options,
      placeholder: record.placeholder,
      prefill: record.prefill,
    };

    if (!this.uiResponder) {
      this.respondUi(request.id, { cancelled: true });
      return;
    }
    this.uiResponder(request);
  }

  private emit(event: NazarEvent): void {
    if (event.type === "settled") {
      this.runController?.settle();
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private trackSessionFile(sessionFile: string | undefined): void {
    if (!sessionFile || sessionFile === this.sessionFile) {
      return;
    }
    this.sessionFile = sessionFile;
    this.options.onSessionFile?.(sessionFile);
  }

  private sessionsRoot(): string {
    const env = { ...process.env, ...this.options.env };
    const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    return join(agentDir, "sessions");
  }
}

function toModelState(data: any): NazarModelState {
  return {
    provider: data?.model?.provider ?? "unknown",
    modelId: data?.model?.id ?? "unknown",
    thinkingLevel: data?.thinkingLevel ?? "off",
    sessionFile: data?.sessionFile,
    messageCount: data?.messageCount ?? 0,
    isStreaming: data?.isStreaming === true,
  };
}

/** pi stores sessions under a directory derived from the cwd with a trailing
 * separator: slashes become dashes and the result is wrapped in dashes. */
export function vaultSessionDirName(cwd: string): string {
  const normalized = `${cwd.replace(/\/+$/, "")}/`;
  return `-${normalized.replaceAll("/", "-")}-`;
}

/** Session files are named after their creation timestamp; use it as a label. */
function sessionLabel(fileName: string): string {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) {
    return fileName;
  }
  return `${match[1]} ${match[2]}:${match[3]}:${match[4]}`;
}

function createRunController(): {
  outcome: Promise<void>;
  settle(): void;
  fail(error: Error): void;
} {
  let settle: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const outcome = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Failures can arrive (via process exit) before anything awaits the
  // outcome; keep the rejection from being reported as unhandled.
  outcome.catch(() => undefined);

  return {
    outcome,
    settle: () => settle(),
    fail: (error) => fail(error),
  };
}

function toNazarEvent(record: any): NazarEvent | undefined {
  if (record?.type === "message_update") {
    const delta = record.assistantMessageEvent;
    if (delta?.type === "text_delta" && typeof delta.delta === "string") {
      return { type: "text", delta: delta.delta };
    }
    return undefined;
  }

  if (record?.type === "tool_execution_start") {
    return {
      type: "tool-start",
      name: record.toolName ?? "unknown",
      args: record.args ?? {},
    };
  }

  if (record?.type === "tool_execution_end") {
    return {
      type: "tool-end",
      name: record.toolName ?? "unknown",
      isError: record.isError === true,
    };
  }

  if (record?.type === "agent_settled") {
    return { type: "settled" };
  }

  return undefined;
}
