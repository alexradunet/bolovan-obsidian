import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createJsonlReader } from "./jsonl";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const ABORT_KILL_TIMEOUT_MS = 5_000;
const SESSION_NAME = "nazar";

export interface RpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface PiTransportOptions {
  /** Working directory for the spawned pi process. */
  cwd: string;
  /**
   * Absolute path to the pi binary, or a getter for it; falls back to PATH
   * lookup and install-location probing. Read at spawn time.
   */
  piPath?: string | (() => string | undefined);
  /** Extra environment variables, merged over the inherited environment. */
  env?: Record<string, string>;
}

interface PendingCommand {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

/**
 * A live pi RPC process, protocol-only. The transport speaks records: it
 * spawns, correlates command responses, delivers events, and dies cleanly.
 * It has no knowledge of sessions, runs, or tools — start() resolving means
 * "the process is alive and reporting its model," and nothing else.
 *
 * Subscribers receive every non-response record unchanged, plus one
 * synthetic { type: "transport_exited", message } record when the process
 * dies on its own. A deliberate stop() emits nothing.
 */
export class PiTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private write: ((command: object) => void) | undefined;
  private pending = new Map<string, PendingCommand>();
  private listeners = new Set<(record: any) => void>();
  private stderrTail = "";
  private resolvedCommand: string | undefined;
  private stopping = false;

  constructor(private readonly options: PiTransportOptions) {}

  subscribe(listener: (record: any) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  started(): boolean {
    return this.child !== undefined;
  }

  /** Spawn the process, handshake, and wait until pi reports its model. */
  async start(options: { sessionFile?: string } = {}): Promise<any> {
    if (this.child) {
      const response = await this.command({ type: "get_state" });
      return response.data ?? {};
    }

    this.stderrTail = "";
    const command = this.resolveCommand();
    this.resolvedCommand = command;

    const child = this.spawn(command, options.sessionFile);
    this.child = child;
    this.write = makeSender(child);

    child.on("error", (error) => {
      this.teardown(new Error(`pi could not be started: ${error.message}. ${this.failureDetail()}`));
    });
    child.on("exit", (code) => {
      const message = `pi exited (code ${code}). ${this.failureDetail()}`;
      const intentional = this.stopping;
      this.teardown(new Error(message));
      if (!intentional) {
        this.deliver({ type: "transport_exited", message });
      }
    });

    this.attachReader(child);

    const state = await this.handshake();
    return this.awaitModel(state);
  }

  /** Send a command and await its correlated response. */
  async command(command: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.write) {
      throw new Error("The pi process is not running");
    }
    return sendCommand(this.write, this.pending, command);
  }

  /** Fire-and-forget write; used for dialog answers. */
  send(record: Record<string, unknown>): void {
    this.write?.(record);
  }

  /** Ask pi to abort the active run; escalate to SIGKILL if it does not. */
  abort(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }

    try {
      child.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
    } catch {
      // A broken stdin means the process is already going away.
    }

    const killTimer = setTimeout(() => {
      if (this.child === child && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, ABORT_KILL_TIMEOUT_MS);
    killTimer.unref?.();
  }

  /** Kill the process deliberately. No exit record is delivered. */
  stop(): void {
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

  private spawn(command: string, sessionFile: string | undefined): ChildProcessWithoutNullStreams {
    const args = ["--mode", "rpc", "--approve", "--name", SESSION_NAME];
    if (sessionFile) {
      args.push("--session", sessionFile);
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

  /** pi resolves the model shortly after startup; wait until get_state sees it. */
  private async awaitModel(state: any): Promise<any> {
    let current = state;
    for (let attempt = 0; attempt < 25 && !current?.model?.id; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const response = await this.command({ type: "get_state" });
      current = response.data ?? {};
    }
    return current;
  }

  private attachReader(child: ChildProcessWithoutNullStreams): void {
    const feed = createJsonlReader((line) => {
      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }

      if (record?.type === "response" && typeof record.id === "string") {
        const entry = this.pending.get(record.id);
        if (!entry) {
          return;
        }
        this.pending.delete(record.id);
        if (record.success) {
          entry.resolve(record);
        } else {
          entry.reject(new Error(record.error || `pi rejected the ${record.command} command`));
        }
        return;
      }

      this.deliver(record);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer) => feed(chunk.toString("utf8")));
  }

  private deliver(record: any): void {
    for (const listener of this.listeners) {
      listener(record);
    }
  }

  private teardown(error: Error): void {
    this.child = undefined;
    this.write = undefined;
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }

  private failureDetail(): string {
    const command = this.resolvedCommand || "pi";
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
