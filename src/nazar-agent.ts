import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createJsonlReader } from "./jsonl";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const ABORT_KILL_TIMEOUT_MS = 5_000;
const SESSION_NAME = "nazar";

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

interface PendingCommand {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Long-lived RPC client for one pi process. The process starts with start()
 * (or implicitly on the first ask) and stays alive until stop(), so chat
 * sessions can stream, steer, and switch models. One run at a time; steering
 * is the only message accepted while running.
 */
export class NazarAgent {
  private child: ChildProcessWithoutNullStreams | undefined;
  private send: ((command: object) => void) | undefined;
  private stderrTail = "";
  private resolvedCommand: string | undefined;
  private pending = new Map<string, PendingCommand>();
  private listeners = new Set<(event: NazarEvent) => void>();
  private uiResponder: ((request: NazarUiRequest) => void) | undefined;
  private runController: ReturnType<typeof createRunController> | undefined;
  private running = false;
  private stopping = false;
  private sessionFile: string | undefined;

  private constructor(private readonly options: NazarAgentOptions) {
    const tracked = options.sessionFile;
    this.sessionFile = tracked && existsSync(tracked) ? tracked : undefined;
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
    if (!this.send) {
      return;
    }
    this.send({ type: "extension_ui_response", id, ...payload });
  }

  status(): NazarAgentStatus {
    return { isRunning: this.running, sessionFile: this.sessionFile };
  }

  started(): boolean {
    return this.child !== undefined;
  }

  /** Spawn the pi process and complete the startup handshake. Idempotent. */
  async start(): Promise<NazarModelState> {
    if (this.child) {
      return this.getState();
    }

    this.stderrTail = "";
    const command = this.resolveCommand();
    this.resolvedCommand = command;

    const child = this.spawnPi(command);
    this.child = child;
    this.send = makeSender(child);

    child.on("error", (error) => {
      const wrapped = new Error(`pi could not be started: ${error.message}. ${this.failureDetail()}`);
      this.teardown(wrapped);
    });
    child.on("exit", (code) => {
      const message = `pi exited (code ${code}). ${this.failureDetail()}`;
      const intentional = this.stopping;
      this.teardown(new Error(message));
      if (!intentional) {
        this.emit({ type: "exited", message });
      }
    });
    attachEventReader(child, this.send, this.pending, (event) => this.emit(event), {
      onUiRequest: (request) => this.handleUiRequest(request),
      onNotify: (message, notifyType) => this.emit({ type: "notify", message, notifyType }),
    });

    const state = await this.handshake();
    this.trackSessionFile(state.sessionFile);
    return this.awaitModel();
  }

  /** pi resolves the model shortly after startup; wait until get_state sees it. */
  private async awaitModel(): Promise<NazarModelState> {
    let state = await this.getState();
    for (let attempt = 0; attempt < 25 && state.modelId === "unknown"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await this.getState();
    }
    return state;
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
    const child = this.child;
    if (!child || !this.running) {
      return;
    }

    try {
      child.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
    } catch {
      // A broken stdin means the process is already going away.
    }

    // If abort does not settle the run, make sure the process dies.
    const killTimer = setTimeout(() => {
      if (this.child === child && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, ABORT_KILL_TIMEOUT_MS);
    killTimer.unref?.();
  }

  /** Kill the process; the agent can be started again. */
  stop(): void {
    this.killChild();
  }

  dispose(): void {
    this.killChild();
    this.listeners.clear();
  }

  async getState(): Promise<NazarModelState> {
    const response = await this.command({ type: "get_state" });
    const data = response.data ?? {};
    return {
      provider: data.model?.provider ?? "unknown",
      modelId: data.model?.id ?? "unknown",
      thinkingLevel: data.thinkingLevel ?? "off",
      sessionFile: data.sessionFile,
      messageCount: data.messageCount ?? 0,
      isStreaming: data.isStreaming === true,
    };
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

  private resolveCommand(): string {
    const configured = typeof this.options.piPath === "function"
      ? this.options.piPath()
      : this.options.piPath;
    const command = findPiBinary({ piPath: configured });
    if (!command) {
      throw new Error(
        "pi binary not found. Install pi (https://pi.dev) or set the binary path in Nazar settings. " +
          "Searched PATH and the common install locations.",
      );
    }
    if (command !== "pi" && !existsSync(command)) {
      throw new Error(`pi binary not found at the configured path: ${command}`);
    }
    return command;
  }

  private async command(command: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.send) {
      throw new Error("Nazar is not connected to pi");
    }
    return sendCommand(this.send, this.pending, command);
  }

  private async handshake(): Promise<any> {
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`pi did not answer the startup handshake in time. ${this.failureDetail()}`));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
    });

    const response = await Promise.race([
      this.command({ type: "get_state" }),
      timeout,
    ]);
    return response.data ?? {};
  }

  private spawnPi(command: string): ChildProcessWithoutNullStreams {
    const args = ["--mode", "rpc", "--approve", "--name", SESSION_NAME];
    if (this.sessionFile) {
      args.push("--session", this.sessionFile);
    }

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: childEnv(command, this.options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    return child;
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

  /** Fail everything in flight after the process dies or cannot start. */
  private teardown(error: Error): void {
    this.child = undefined;
    this.send = undefined;
    this.running = false;
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
    this.runController?.fail(error);
    this.runController = undefined;
  }

  private trackSessionFile(sessionFile: string | undefined): void {
    if (!sessionFile || sessionFile === this.sessionFile) {
      return;
    }
    this.sessionFile = sessionFile;
    this.options.onSessionFile?.(sessionFile);
  }

  private killChild(): void {
    const child = this.child;
    this.stopping = true;
    this.teardown(new Error("Nazar stopped"));
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
    // Reset after the exit event has had a chance to observe the flag.
    setTimeout(() => {
      this.stopping = false;
    }, 100).unref?.();
  }

  private sessionsRoot(): string {
    const env = { ...process.env, ...this.options.env };
    const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    return join(agentDir, "sessions");
  }

  private failureDetail(): string {
    const command = this.resolvedCommand || "pi";
    const detail = this.stderrTail.trim();
    return detail ? `Tried ${command}. ${detail}` : `Tried ${command}.`;
  }
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

/**
 * Resolve the pi binary. Desktop Obsidian sessions usually do not inherit the
 * shell PATH, so a bare PATH lookup is not enough: after PATH, probe the
 * stable install locations the pi installer maintains.
 */
export function findPiBinary(options: {
  piPath?: string;
  pathEnv?: string;
  homeDir?: string;
} = {}): string | undefined {
  if (options.piPath) {
    return options.piPath;
  }

  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, "pi");
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const homeDir = options.homeDir ?? homedir();
  const probeLocations = [
    join(homeDir, ".local", "bin", "pi"),
    "/usr/local/bin/pi",
    join(homeDir, ".local", "share", "pi-node", "current", "bin", "pi"),
  ];
  for (const candidate of probeLocations) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Build the child environment. Desktop sessions often lack the shell PATH,
 * and the pi launcher is a node script: the directory holding the resolved
 * pi binary also holds the matching node, so it goes first on PATH. When no
 * PATH exists at all, restore the standard system directories so pi's own
 * tools still find basic commands.
 */
function childEnv(command: string, extraEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const fallbackPath = "/usr/local/bin:/usr/bin:/bin";
  const configuredPath = env.PATH ?? "";
  const basePath = configuredPath || fallbackPath;
  env.PATH = `${dirname(command)}${delimiter}${basePath}`;
  return env;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

function makeSender(child: ChildProcessWithoutNullStreams): (command: object) => void {
  return (command) => {
    child.stdin.write(JSON.stringify(command) + "\n");
  };
}

async function sendCommand(
  send: (command: object) => void,
  pending: Map<string, PendingCommand>,
  command: Record<string, unknown>,
): Promise<RpcResponse> {
  const id = `nazar-${Math.random().toString(36).slice(2, 10)}`;

  const response = new Promise<RpcResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });

  try {
    send({ ...command, id });
  } catch (error) {
    pending.delete(id);
    throw error instanceof Error ? error : new Error(String(error));
  }

  return response;
}

function attachEventReader(
  child: ChildProcessWithoutNullStreams,
  send: (command: object) => void,
  pending: Map<string, PendingCommand>,
  onEvent: (event: NazarEvent) => void,
  hooks: {
    onUiRequest(record: any): void;
    onNotify(message: string, notifyType: string): void;
  },
): void {
  const feed = createJsonlReader((line) => {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    if (record?.type === "response" && typeof record.id === "string") {
      const entry = pending.get(record.id);
      if (!entry) {
        return;
      }
      pending.delete(record.id);
      if (record.success) {
        entry.resolve(record);
      } else {
        entry.reject(new Error(record.error || `pi rejected the ${record.command} command`));
      }
      return;
    }

    if (record?.type === "extension_ui_request") {
      if (typeof record.id !== "string") {
        return;
      }
      if (record.method === "notify") {
        hooks.onNotify(String(record.message ?? ""), String(record.notifyType ?? "info"));
        return;
      }
      hooks.onUiRequest(record);
      return;
    }

    const nazarEvent = toNazarEvent(record);
    if (nazarEvent) {
      onEvent(nazarEvent);
    }
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: Buffer) => feed(chunk.toString("utf8")));
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
