import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NazarAgent, type NazarEvent } from "../src/nazar-agent";

const TEST_TIMEOUT_MS = 60_000;
const HANDSHAKE_BUDGET_MS = 5_000;

interface TestEnvironment {
  vaultDir: string;
  agentDir: string;
  requestBodies: any[];
  close(): Promise<void>;
}

const environments: TestEnvironment[] = [];
const agents: NazarAgent[] = [];

afterEach(async () => {
  for (const agent of agents) {
    agent.dispose();
  }
  agents.length = 0;

  for (const environment of environments) {
    await environment.close();
  }
  environments.length = 0;
});

describe("NazarAgent over pi RPC", () => {
  it(
    "runs pi against a synthetic vault with built-in tools",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await createTestEnvironment();
      let sessionFileReported: string | undefined;

      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: agentEnv(environment),
        onSessionFile: (sessionFile) => {
          sessionFileReported = sessionFile;
        },
      });

      const events: NazarEvent[] = [];
      agent.subscribe((event) => events.push(event));
      await agent.ask("Summarize today's journal.");

      expect(agent.status().isRunning).toBe(false);

      const toolRuns = events.filter((event) => event.type.startsWith("tool-"));
      expect(toolRuns).toContainEqual({
        type: "tool-start",
        name: "read",
        args: { path: "Journal/Today.md" },
      });
      expect(toolRuns).toContainEqual({
        type: "tool-end",
        name: "read",
        isError: false,
      });
      expect(events.some((event) => event.type === "settled")).toBe(true);

      const text = events
        .filter((event): event is { type: "text"; delta: string } => event.type === "text")
        .map((event) => event.delta)
        .join("");
      expect(text).toContain("A grounded summary.");

      expect(sessionFileReported).toBeTruthy();
      expect(agent.status().sessionFile).toBe(sessionFileReported);
      await expect(readFile(sessionFileReported!, "utf8")).resolves.toContain("Summarize");
    },
  );

  it(
    "keeps the process alive across runs",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await createTestEnvironment();
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: agentEnv(environment),
      });

      let settledCount = 0;
      agent.subscribe((event) => {
        if (event.type === "settled") {
          settledCount += 1;
        }
      });

      await agent.ask("First question.");
      const stateBetweenRuns = await agent.getState();
      await agent.ask("Second question.");

      expect(settledCount).toBe(2);
      expect(agent.started()).toBe(true);
      expect(stateBetweenRuns.messageCount).toBeGreaterThan(0);
    },
  );

  it(
    "resumes the tracked session lineage across agent instances",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await createTestEnvironment();
      let sessionFileReported: string | undefined;

      const firstAgent = await createAgent({
        cwd: environment.vaultDir,
        env: agentEnv(environment),
        onSessionFile: (sessionFile) => {
          sessionFileReported = sessionFile;
        },
      });
      await firstAgent.ask("First question.");
      const trackedSessionFile = sessionFileReported;
      expect(trackedSessionFile).toBeTruthy();
      firstAgent.stop();

      const secondAgent = await createAgent({
        cwd: environment.vaultDir,
        env: agentEnv(environment),
        sessionFile: trackedSessionFile,
      });
      const events: NazarEvent[] = [];
      secondAgent.subscribe((event) => events.push(event));
      await secondAgent.ask("Second question.");

      expect(secondAgent.status().sessionFile).toBe(trackedSessionFile);

      const bodies = environment.requestBodies;
      expect(bodies.length).toBeGreaterThanOrEqual(3);
      const firstRunFirstRequest = bodies[0];
      const secondRunFirstRequest = bodies[2];
      expect(secondRunFirstRequest.messages.length).toBeGreaterThan(
        firstRunFirstRequest.messages.length,
      );
      expect(JSON.stringify(secondRunFirstRequest)).toContain("First question.");
    },
  );

  it(
    "lists vault sessions and starts a fresh lineage",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await createTestEnvironment();
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: agentEnv(environment),
      });

      await agent.ask("First question.");
      const originalSessionFile = agent.status().sessionFile;
      expect(originalSessionFile).toBeTruthy();

      const sessions = agent.listSessions();
      expect(sessions.some((session) => session.path === originalSessionFile)).toBe(true);
      expect(sessions[0]?.label).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      const newSessionFile = await agent.newSession();
      expect(newSessionFile).toBeTruthy();
      expect(newSessionFile).not.toBe(originalSessionFile);
      expect((await agent.getState()).messageCount).toBe(0);
    },
  );

  it(
    "fails fast when the pi binary cannot be started",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await createTestEnvironment();
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: agentEnv(environment),
        piPath: "/nonexistent/nazar-test-pi",
      });

      const startedAt = Date.now();
      await expect(agent.ask("Hello.")).rejects.toThrow(/pi/);
      // Must fail at spawn time, not after the 10s handshake timeout.
      expect(Date.now() - startedAt).toBeLessThan(HANDSHAKE_BUDGET_MS);
    },
  );

  it(
    "falls back to probing install locations when PATH lacks pi",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // Desktop Obsidian sessions typically do not inherit the shell PATH.
      const environment = await createTestEnvironment();
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: { ...agentEnv(environment), PATH: "/usr/bin:/bin" },
      });

      const events: NazarEvent[] = [];
      agent.subscribe((event) => events.push(event));
      await agent.ask("Summarize today's journal.");

      const text = events
        .filter((event): event is { type: "text"; delta: string } => event.type === "text")
        .map((event) => event.delta)
        .join("");
      expect(text).toContain("A grounded summary.");
    },
  );

  it(
    "cancels an active run",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await createTestEnvironment({
        respond: (requestIndex, response) => {
          beginEventStream(response);
          sendChunk(response, {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Starting" },
                finish_reason: null,
              },
            ],
          });
          if (requestIndex > 0) {
            // Keep the stream open past the first request so the run stays
            // active until the test cancels it.
            return;
          }
          sendChunk(response, {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
          response.end();
        },
      });

      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: agentEnv(environment),
      });

      let sawText: () => void = () => undefined;
      const textReceived = new Promise<void>((resolve) => {
        sawText = resolve;
      });

      agent.subscribe((event) => {
        if (event.type === "text") {
          sawText();
        }
      });

      const run = agent.ask("Keep streaming.");
      await textReceived;

      expect(agent.status().isRunning).toBe(true);
      await agent.cancel();
      await run;
      expect(agent.status().isRunning).toBe(false);
    },
  );
});

interface TestEnvironmentOptions {
  respond?(requestIndex: number, response: ServerResponse): void;
}

async function createTestEnvironment(
  options: TestEnvironmentOptions = {},
): Promise<TestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "nazar-test-"));
  const vaultDir = join(root, "vault");
  const agentDir = join(root, "agent");
  await mkdir(join(vaultDir, "Journal"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(vaultDir, "Journal", "Today.md"),
    "Today I finished the integration spike.",
  );

  const requestBodies: any[] = [];
  let requestIndex = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        requestBodies.push(JSON.parse(body));
      } catch {
        requestBodies.push(undefined);
      }

      const respond = options.respond ?? defaultRespond;
      respond(requestIndex, response);
      requestIndex += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic model server did not expose a TCP port");
  }

  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "nazar-test",
      defaultModel: "test-model",
      enableInstallTelemetry: false,
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "nazar-test": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "local-test",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [
            {
              id: "test-model",
              name: "Nazar test model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );

  const environment: TestEnvironment = {
    vaultDir,
    agentDir,
    requestBodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(root, { recursive: true, force: true });
    },
  };
  environments.push(environment);
  return environment;
}

function defaultRespond(requestIndex: number, response: ServerResponse): void {
  beginEventStream(response);

  if (requestIndex === 0) {
    sendChunk(response, {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read-note",
                type: "function",
                function: {
                  name: "read",
                  arguments: '{"path":"Journal/Today.md"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sendChunk(response, {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  } else {
    sendChunk(response, {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "A grounded summary." },
          finish_reason: null,
        },
      ],
    });
    sendChunk(response, {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }

  response.end();
}

function agentEnv(environment: TestEnvironment): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: environment.agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  };
}

async function createAgent(
  options: Parameters<typeof NazarAgent.create>[0],
): Promise<NazarAgent> {
  const agent = NazarAgent.create(options);
  agents.push(agent);
  return agent;
}

function beginEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });
}

function sendChunk(response: ServerResponse, chunk: object): void {
  response.write(`data: ${JSON.stringify({
    id: "synthetic-response",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    ...chunk,
  })}\n\n`);
}
