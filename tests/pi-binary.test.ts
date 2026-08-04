import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPiBinary, vaultSessionDirName } from "../src/nazar-agent";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

async function createFakeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nazar-pi-binary-test-"));
  roots.push(root);
  return root;
}

async function createExecutable(dir: string, name = "pi"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

describe("findPiBinary", () => {
  it("returns the explicit piPath untouched", async () => {
    const homeDir = await createFakeHome();

    const found = findPiBinary({ piPath: "/custom/pi", pathEnv: "", homeDir });

    expect(found).toBe("/custom/pi");
  });

  it("finds pi on PATH before probing install locations", async () => {
    const homeDir = await createFakeHome();
    const pathDir = join(homeDir, "bin");
    const pathPi = await createExecutable(pathDir);
    await createExecutable(join(homeDir, ".local", "bin"));

    const found = findPiBinary({ pathEnv: pathDir, homeDir });

    expect(found).toBe(pathPi);
  });

  it("probes ~/.local/bin when PATH does not contain pi", async () => {
    const homeDir = await createFakeHome();
    const localPi = await createExecutable(join(homeDir, ".local", "bin"));

    const found = findPiBinary({ pathEnv: "/usr/bin:/bin", homeDir });

    expect(found).toBe(localPi);
  });

  it("probes the pi-node installer location last", async () => {
    const homeDir = await createFakeHome();
    const installerPi = await createExecutable(
      join(homeDir, ".local", "share", "pi-node", "current", "bin"),
    );

    const found = findPiBinary({ pathEnv: "/usr/bin:/bin", homeDir });

    expect(found).toBe(installerPi);
  });

  it("returns undefined when nothing is found", async () => {
    const homeDir = await createFakeHome();

    const found = findPiBinary({ pathEnv: "/usr/bin:/bin", homeDir });

    expect(found).toBeUndefined();
  });

  it("ignores PATH entries that are not executable files", async () => {
    const homeDir = await createFakeHome();
    const dirWithDirNamedPi = join(homeDir, "not-exec");
    await mkdir(join(dirWithDirNamedPi, "pi"), { recursive: true });

    const found = findPiBinary({ pathEnv: dirWithDirNamedPi, homeDir });

    expect(found).toBeUndefined();
  });
});

describe("vaultSessionDirName", () => {
  it("matches the naming pi uses for session directories", () => {
    expect(vaultSessionDirName("/home/alex/SecondBrain")).toBe(
      "--home-alex-SecondBrain--",
    );
    expect(vaultSessionDirName("/home/alex/SecondBrain/")).toBe(
      "--home-alex-SecondBrain--",
    );
    expect(vaultSessionDirName("/home/alex")).toBe("--home-alex--");
  });
});
