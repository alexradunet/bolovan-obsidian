import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NazarAgent, type NazarEvent } from "../src/nazar-agent";
import { createFakePiEnvironment, type FakeTurn, type FakePiEnvironment } from "./fake-model";

const TEST_TIMEOUT_MS = 60_000;
const HANDSHAKE_BUDGET_MS = 5_000;

/** The common scenario: the model reads the journal note, then answers. */
const READ_JOURNAL_SCRIPT: FakeTurn[][] = [
  [{ toolCall: { name: "read", arguments: { path: "Journal/Today.md" } } }],
  [{ text: "A grounded summary." }],
];

const WRITE_NOTE_SCRIPT: FakeTurn[][] = [
  [{ toolCall: { name: "write", arguments: { path: "Drafts/Note.md", content: "gated content" } } }],
  [{ text: "Done." }],
];

const WRITE_GATE_EXTENSION = [
  "export default function (pi: any): void {",
  "  pi.on('tool_call', async (event: any, ctx: any) => {",
  "    if (event.toolName !== 'write') return;",
  "    const ok = await ctx.ui.confirm('Approve write?', String(event.input.path));",
  "    if (!ok) return { block: true, reason: 'Rejected by user' };",
  "  });",
  "}",
  "",
].join("\n");

const environments: FakePiEnvironment[] = [];
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
      const environment = await track(createFakePiEnvironment({ script: READ_JOURNAL_SCRIPT }));
      let sessionFileReported: string | undefined;

      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
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

      const text = textOf(events);
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
      const environment = await track(createFakePiEnvironment({ script: READ_JOURNAL_SCRIPT }));
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
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
      const environment = await track(createFakePiEnvironment({ script: READ_JOURNAL_SCRIPT }));
      let sessionFileReported: string | undefined;

      const firstAgent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
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
        env: environment.env,
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
      const environment = await track(createFakePiEnvironment({ script: READ_JOURNAL_SCRIPT }));
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
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
      const environment = await track(createFakePiEnvironment({ script: READ_JOURNAL_SCRIPT }));
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
        piPath: "/nonexistent/nazar-test-pi",
      });

      const startedAt = Date.now();
      await expect(agent.ask("Hello.")).rejects.toThrow(/pi/);
      // Must fail at spawn time, not after the 10s handshake timeout.
      expect(Date.now() - startedAt).toBeLessThan(HANDSHAKE_BUDGET_MS);
    },
  );

  it(
    "applies a changed pi path at the next spawn",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await track(createFakePiEnvironment({ script: READ_JOURNAL_SCRIPT }));
      let configuredPath: string | undefined = "/nonexistent/nazar-test-pi";

      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
        piPath: () => configuredPath,
      });

      await expect(agent.ask("Hello.")).rejects.toThrow(/pi/);

      // The getter now returns nothing: the fallback lookup finds the real
      // binary, and the respawn picks it up.
      configuredPath = undefined;
      const events: NazarEvent[] = [];
      agent.subscribe((event) => events.push(event));
      await agent.ask("Summarize today's journal.");

      expect(textOf(events)).toContain("A grounded summary.");
    },
  );

  it(
    "falls back to probing install locations when PATH lacks pi",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      // Desktop Obsidian sessions typically do not inherit the shell PATH.
      const environment = await track(createFakePiEnvironment({ script: READ_JOURNAL_SCRIPT }));
      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: { ...environment.env, PATH: "/usr/bin:/bin" },
      });

      const events: NazarEvent[] = [];
      agent.subscribe((event) => events.push(event));
      await agent.ask("Summarize today's journal.");

      expect(textOf(events)).toContain("A grounded summary.");
    },
  );

  it(
    "routes write approval through the dialog responder",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await track(createFakePiEnvironment({
        script: WRITE_NOTE_SCRIPT,
        extensions: { "gate.ts": WRITE_GATE_EXTENSION },
      }));

      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
      });
      agent.setUiResponder((request) => {
        agent.respondUi(request.id, { confirmed: true });
      });

      const events: NazarEvent[] = [];
      agent.subscribe((event) => events.push(event));
      await agent.ask("Write a note.");

      const gatedFile = join(environment.vaultDir, "Drafts", "Note.md");
      await expect(readFile(gatedFile, "utf8")).resolves.toContain("gated content");
      expect(events).toContainEqual({
        type: "tool-end",
        name: "write",
        isError: false,
      });
    },
  );

  it(
    "blocks a write the user rejects",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await track(createFakePiEnvironment({
        script: WRITE_NOTE_SCRIPT,
        extensions: { "gate.ts": WRITE_GATE_EXTENSION },
      }));

      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
      });
      agent.setUiResponder((request) => {
        agent.respondUi(request.id, { confirmed: false });
      });

      const events: NazarEvent[] = [];
      agent.subscribe((event) => events.push(event));
      await agent.ask("Write a note.");

      const gatedFile = join(environment.vaultDir, "Drafts", "Note.md");
      await expect(readFile(gatedFile, "utf8")).rejects.toThrow();
      expect(events).toContainEqual({
        type: "tool-end",
        name: "write",
        isError: true,
      });
      expect(events.some((event) => event.type === "settled")).toBe(true);
    },
  );

  it(
    "cancels an active run",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const environment = await track(createFakePiEnvironment({
        script: [[{ text: "Starting" }, { hang: true }]],
      }));

      const agent = await createAgent({
        cwd: environment.vaultDir,
        env: environment.env,
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

async function track(
  environmentPromise: Promise<FakePiEnvironment>,
): Promise<FakePiEnvironment> {
  const environment = await environmentPromise;
  environments.push(environment);
  return environment;
}

async function createAgent(
  options: Parameters<typeof NazarAgent.create>[0],
): Promise<NazarAgent> {
  const agent = NazarAgent.create(options);
  agents.push(agent);
  return agent;
}

function textOf(events: NazarEvent[]): string {
  return events
    .filter((event): event is { type: "text"; delta: string } => event.type === "text")
    .map((event) => event.delta)
    .join("");
}
