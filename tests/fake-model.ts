import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * One turn of a scripted fake-model response. Each turn becomes one SSE
 * chunk. `hang` leaves the stream open so tests can exercise cancellation.
 */
export type FakeTurn =
  | { toolCall: { id?: string; name: string; arguments: string | object } }
  | { text: string }
  | { hang: true };

export interface FakePiEnvironmentOptions {
  /** One turn list per model request; requests past the script repeat its last entry. */
  script: FakeTurn[][];
  /** Extra vault files beyond the default journal note; path relative to the vault. */
  vaultFiles?: Record<string, string>;
  /** Project extensions written into the synthetic vault's .pi/extensions. */
  extensions?: Record<string, string>;
}

export interface FakePiEnvironment {
  vaultDir: string;
  agentDir: string;
  /** Pass straight to BolovanAgent.create as `env`. */
  env: Record<string, string>;
  /** Parsed request bodies pi sent to the model, in order. */
  requestBodies: any[];
  close(): Promise<void>;
}

/**
 * A hermetic pi test environment: synthetic vault, isolated pi config dir
 * wired to a scripted fake OpenAI-compatible model server, and the env
 * block for a BolovanAgent. Real pi spawns against it; nothing outside the
 * temp dirs is touched.
 */
export async function createFakePiEnvironment(
  options: FakePiEnvironmentOptions,
): Promise<FakePiEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "bolovan-test-"));
  const vaultDir = join(root, "vault");
  const agentDir = join(root, "agent");
  await mkdir(join(vaultDir, "Journal"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(vaultDir, "Journal", "Today.md"),
    "Today I finished the integration spike.",
  );

  for (const [path, content] of Object.entries(options.vaultFiles ?? {})) {
    const target = join(vaultDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  for (const [name, source] of Object.entries(options.extensions ?? {})) {
    const extensionsDir = join(vaultDir, ".pi", "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(join(extensionsDir, name), source);
  }

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

      const script = options.script;
      const behavior = script[Math.min(requestIndex, script.length - 1)] ?? [];
      requestIndex += 1;
      respondWithTurns(response, behavior);
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
      defaultProvider: "bolovan-test",
      defaultModel: "test-model",
      enableInstallTelemetry: false,
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "bolovan-test": {
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
              name: "Bolovan test model",
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

  return {
    vaultDir,
    agentDir,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    requestBodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function respondWithTurns(response: ServerResponse, turns: FakeTurn[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "keep-alive",
    "cache-control": "no-cache",
  });

  let finishReason = "stop";
  let toolCallIndex = 0;
  for (const turn of turns) {
    if ("hang" in turn) {
      return; // Leave the stream open; the test owns what happens next.
    }

    if ("toolCall" in turn) {
      finishReason = "tool_calls";
      const call = turn.toolCall;
      sendChunk(response, {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: toolCallIndex,
                  id: call.id ?? `call-${toolCallIndex}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: typeof call.arguments === "string"
                      ? call.arguments
                      : JSON.stringify(call.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      toolCallIndex += 1;
    } else {
      sendChunk(response, {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: turn.text },
            finish_reason: null,
          },
        ],
      });
    }
  }

  sendChunk(response, {
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
  response.end();
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
