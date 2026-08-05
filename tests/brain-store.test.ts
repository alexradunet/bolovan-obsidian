import { describe, expect, it } from "vitest";

import { BrainStore } from "../src/brain-store";
import { fakeApp } from "./fake-app";

const FOREIGN_BRANCH = "Brain/Sessions/conversation-1--remote--branch-1.json";

function foreignBranch(): string {
  return `${JSON.stringify({
    format: 1,
    conversationId: "conversation-1",
    branchId: "branch-1",
    deviceId: "remote",
    createdAt: "2026-08-01T12:00:00.000Z",
    modifiedAt: "2026-08-01T12:00:00.000Z",
    title: "Remote conversation",
    model: "test-model",
    messages: [{ role: "user", content: "remote message" }],
  }, null, 2)}\n`;
}

describe("BrainStore device-owned branches", () => {
  it("forks a foreign branch before appending and leaves the foreign history unchanged", async () => {
    const app = fakeApp({
      "Brain/bolovan-brain.json": "{\"format\":1}",
      [FOREIGN_BRANCH]: foreignBranch(),
    });
    const store = new BrainStore(app, {
      folder: "Brain",
      deviceId: "local",
      activeBranch: FOREIGN_BRANCH,
    });

    await store.initialize();
    await store.append([{ role: "assistant", content: "local reply" }], "test-model");

    const localBranch = store.activeBranchPath();
    expect(localBranch).toContain("--local--");
    expect(localBranch).not.toBe(FOREIGN_BRANCH);
    expect(store.messages()).toEqual([
      { role: "user", content: "remote message" },
      { role: "assistant", content: "local reply" },
    ]);
    expect(store.list()).toHaveLength(2);

    await store.switch(FOREIGN_BRANCH);
    expect(store.messages()).toEqual([{ role: "user", content: "remote message" }]);
  });
});
