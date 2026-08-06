import { describe, expect, it, vi } from "vitest";
import { SkillStore, MAX_RESOURCE_CHARS } from "../src/skills";
import { fakeApp } from "./fake-app";

const skill = (name: string, description = "Reviews observed work. Use after completing a change.", body = "# Review\n\nCheck the result.") =>
  `---\n${JSON.stringify({ name, description, compatibility: "Bolovan", metadata: { version: "1" }, "allowed-tools": "vault_read" })}\n---\n${body}`;

describe("SkillStore canonical Agent Skills", () => {
  it("catalogs immediate valid packages and activates instructions progressively", async () => {
    const app = fakeApp({
      "Brain/Skills/code-review/SKILL.md": skill("code-review"),
      "Brain/Skills/code-review/references/checklist.md": "Check observable behavior.",
      "Brain/Skills/flat.md": "not a package",
      "Brain/Skills/nested/example/SKILL.md": skill("example"),
    });
    const store = new SkillStore(app, "Brain");

    const discovery = await store.discover();
    expect(discovery.skills).toEqual([{
      name: "code-review",
      description: "Reviews observed work. Use after completing a change.",
      path: "Brain/Skills/code-review/SKILL.md",
    }]);
    expect(discovery.diagnostics).toEqual([]);
    expect(await store.activate("code-review")).toMatchObject({
      name: "code-review",
      instructions: "# Review\n\nCheck the result.",
      compatibility: "Bolovan",
      resources: ["references/checklist.md"],
    });
  });

  it("confines bounded resource reads to the selected package", async () => {
    const app = fakeApp({
      "Brain/Skills/code-review/SKILL.md": skill("code-review"),
      "Brain/Skills/code-review/references/checklist.md": "checklist",
      "Brain/Skills/code-review/scripts/check.sh": "echo no execution",
      "Brain/Skills/code-review/references/large.md": "x".repeat(MAX_RESOURCE_CHARS + 1),
      "Brain/Secret.md": "secret",
    });
    const store = new SkillStore(app, "Brain");

    await expect(store.readResource("code-review", "references/checklist.md")).resolves.toBe("checklist");
    await expect(store.readResource("code-review", "scripts/check.sh")).resolves.toBe("echo no execution");
    await expect(store.readResource("code-review", "../Secret.md")).rejects.toThrow("inside the skill directory");
    await expect(store.readResource("code-review", "references/large.md")).rejects.toThrow("exceeds");
  });

  it("isolates invalid packages and reports an unchanged diagnostic state once", async () => {
    const onDiagnostics = vi.fn();
    const app = fakeApp({
      "Brain/Skills/good/SKILL.md": skill("good"),
      "Brain/Skills/wrong/SKILL.md": skill("different"),
      "Brain/Skills/missing/SKILL.md": "# no frontmatter",
    });
    const store = new SkillStore(app, "Brain", onDiagnostics);

    const first = await store.discover();
    await store.discover();

    expect(first.skills.map((entry) => entry.name)).toEqual(["good"]);
    expect(first.diagnostics).toHaveLength(2);
    expect(onDiagnostics).toHaveBeenCalledTimes(1);
  });
});
