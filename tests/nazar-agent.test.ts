import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NazarAgent, type NazarEvent } from "../src/nazar-agent";

const agents: NazarAgent[] = [];

afterEach(() => {
  for (const agent of agents) {
    agent.dispose();
  }
  agents.length = 0;
});

describe("NazarAgent", () => {
  it("creates an offline Pi session with only the scoped vault tool", async () => {
    const agent = await createAgent({
      baseUrl: "http://127.0.0.1:8080/v1",
      modelId: "test-model",
      readNote: async () => "synthetic note",
    });

    expect(agent.status()).toEqual({
      modelId: "test-model",
      activeTools: ["vault_read"],
      isRunning: false,
    });
  });

  it("streams a vault tool call and final response through Pi", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      beginEventStream(response);

      if (requestCount === 1) {
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
                      name: "vault_read",
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

      response.write("data: [DONE]\n\n");
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic model server did not expose a TCP port");
      }

      const readPaths: string[] = [];
      const events: NazarEvent[] = [];
      const agent = await createAgent({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: "test-model",
        readNote: async (path) => {
          readPaths.push(path);
          return "Today I finished the integration spike.";
        },
      });

      await agent.ask("Summarize today's journal.", (event) => events.push(event));

      expect(requestCount).toBe(2);
      expect(readPaths).toEqual(["Journal/Today.md"]);
      expect(events).toContainEqual({ type: "tool-start", name: "vault_read" });
      expect(events).toContainEqual({ type: "tool-end", name: "vault_read", isError: false });
      expect(events).toContainEqual({ type: "text", delta: "A grounded summary." });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cancels an active local model stream", async () => {
    let response: ServerResponse | undefined;
    const server = createServer((_request, serverResponse) => {
      response = serverResponse;
      beginEventStream(serverResponse);
      sendChunk(serverResponse, {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Starting" },
            finish_reason: null,
          },
        ],
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic model server did not expose a TCP port");
      }

      const agent = await createAgent({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId: "test-model",
        readNote: async () => "synthetic note",
      });
      let sawText: () => void = () => undefined;
      const textReceived = new Promise<void>((resolve) => {
        sawText = resolve;
      });

      const run = agent.ask("Keep streaming.", (event) => {
        if (event.type === "text") {
          sawText();
        }
      });
      await textReceived;

      expect(agent.status().isRunning).toBe(true);
      await agent.cancel();
      await run;
      expect(agent.status().isRunning).toBe(false);
    } finally {
      response?.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

async function createAgent(options: Parameters<typeof NazarAgent.create>[0]): Promise<NazarAgent> {
  const agent = await NazarAgent.create(options);
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
