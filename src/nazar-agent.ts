import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createJsonlReader } from "./jsonl";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const ABORT_KILL_TIMEOUT_MS = 5_000;
const SESSION_NAME = "nazar";

export interface NazarAgentOptions {
  /** Vault root; the spawned pi process runs with this cwd. */
  cwd: string;
  /** Absolute path to the pi binary; falls back to PATH lookup. */
  piPath?: string;
  /** Session file tracked from a previous run; absent means a fresh session. */
  sessionFile?: string;
  /** Extra environment variables, merged over the inherited environment. */
  env?: Record<string, string>;
  /** Called whenever the resolved session file path changes. */
  onSessionFile?(sessionFile: string): void;
}

export type NazarEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; name: string }
  | { type: "tool-end"; name: string; isError: boolean };

export interface NazarAgentStatus {
  isRunning: boolean;
  sessionFile: string | undefined;
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

export class NazarAgent {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stderrTail = "";
  private resolvedCommand: string | undefined;
  private pending = new Map<string, PendingCommand>();
  private running = false;
  private sessionFile: string | undefined;

  private constructor(private readonly options: NazarAgentOptions) {
    const tracked = options.sessionFile;
    this.sessionFile = tracked && existsSync(tracked) ? tracked : undefined;
  }

  static create(options: NazarAgentOptions): NazarAgent {
    return new NazarAgent(options);
  }

  status(): NazarAgentStatus {
    return { isRunning: this.running, sessionFile: this.sessionFile };
  }

  /** Drop the tracked session lineage; the next run starts a fresh session. */
  resetSession(): void {
    this.sessionFile = undefined;
    this.options.onSessionFile?.("");
  }

  async ask(prompt: string, onEvent: (event: NazarEvent) => void): Promise<void> {
    if (this.running) {
      throw new Error("Nazar is already running");
    }

    this.running = true;
    this.stderrTail = "";

    const command = findPiBinary({ piPath: this.options.piPath });
    if (!command) {
      this.running = false;
      throw new Error(
        "pi binary not found. Install pi (https://pi.dev) or set the binary path in Nazar settings. " +
          "Searched PATH and the common install locations.",
      );
    }
    if (command !== "pi" && !existsSync(command)) {
      this.running = false;
      throw new Error(`pi binary not found at the configured path: ${command}`);
    }
    this.resolvedCommand = command;

    const child = this.spawnPi(command);
    this.child = child;
    const send = makeSender(child);

    // One reader spans the whole run: handshake response, prompt response,
    // streamed events, and the settled signal all arrive on the same stdout.
    const run = createRunController();
    child.on("error", (error) => {
      // ENOENT/EACCES surface here, not as an exit. Without this handler the
      // error is unhandled and the run would sit until the handshake timeout.
      const wrapped = new Error(`pi could not be started: ${error.message}. ${this.failureDetail()}`);
      this.rejectAllPending(wrapped);
      run.fail(wrapped);
    });
    const reader = attachEventReader(child, send, this.pending, {
      onEvent,
      onSettled: run.settle,
      onExit: (code) => {
        const error = new Error(`pi exited during the run (code ${code}). ${this.failureDetail()}`);
        this.rejectAllPending(error);
        run.fail(error);
      },
    });

    try {
      const state = await this.handshake(send);
      this.trackSessionFile(state?.sessionFile);
      await sendCommand(send, this.pending, { type: "prompt", message: prompt });
      await run.outcome;
      if (!this.sessionFile) {
        // Fresh sessions only get a file once something happened; ask again.
        const finalState = await sendCommand(send, this.pending, { type: "get_state" });
        this.trackSessionFile(finalState.data?.sessionFile);
      }
    } finally {
      reader.detach();
      this.killChild();
      this.running = false;
    }
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

  dispose(): void {
    this.killChild();
    this.running = false;
  }

  private async handshake(send: (command: object) => void): Promise<any> {
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`pi did not answer the startup handshake in time. ${this.failureDetail()}`));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
    });

    const state = await Promise.race([
      sendCommand(send, this.pending, { type: "get_state" }),
      timeout,
    ]);
    return state.data;
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

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
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
    this.child = undefined;
    this.rejectAllPending(new Error("Nazar stopped"));
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  private failureDetail(): string {
    const command = this.resolvedCommand || this.options.piPath || "pi";
    const detail = this.stderrTail.trim();
    return detail ? `Tried ${command}. ${detail}` : `Tried ${command}.`;
  }
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

interface ReaderHooks {
  onEvent(event: NazarEvent): void;
  onSettled(): void;
  onExit(code: number | null): void;
}

function attachEventReader(
  child: ChildProcessWithoutNullStreams,
  send: (command: object) => void,
  pending: Map<string, PendingCommand>,
  hooks: ReaderHooks,
): { detach(): void } {
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
      // Dialog requests would block the agent; the plugin never opts into
      // extension dialogs, so cancel them immediately.
      if (typeof record.id === "string") {
        send({ type: "extension_ui_response", id: record.id, cancelled: true });
      }
      return;
    }

    const nazarEvent = toNazarEvent(record);
    if (nazarEvent) {
      hooks.onEvent(nazarEvent);
    }
    if (record?.type === "agent_settled") {
      hooks.onSettled();
    }
  });

  const onData = (chunk: Buffer) => feed(chunk.toString("utf8"));
  const onExit = (code: number | null) => hooks.onExit(code);

  child.stdout.on("data", onData);
  child.on("exit", onExit);

  return {
    detach() {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    },
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
    return { type: "tool-start", name: record.toolName ?? "unknown" };
  }

  if (record?.type === "tool_execution_end") {
    return {
      type: "tool-end",
      name: record.toolName ?? "unknown",
      isError: record.isError === true,
    };
  }

  return undefined;
}
