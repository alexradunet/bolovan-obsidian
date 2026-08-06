import { parseYaml, type App, type TFile } from "obsidian";

export const MAX_SKILLS = 100;
export const MAX_SKILL_CHARS = 40_000;
export const MAX_RESOURCE_CHARS = 40_000;
export const MAX_ACTIVE_SKILL_CHARS = 80_000;
export const MAX_CATALOG_CHARS = 20_000;
const MAX_RESOURCES = 100;

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export interface SkillDiagnostic {
  path: string;
  message: string;
}

interface Skill extends SkillSummary {
  body: string;
  compatibility?: string;
  resources: string[];
}

export interface SkillDiscovery {
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

export interface ActivatedSkill {
  name: string;
  description: string;
  compatibility?: string;
  instructions: string;
  resources: string[];
}

export class SkillStore {
  private discovered = new Map<string, Skill>();
  private diagnosticKey = "";

  constructor(
    private readonly app: App,
    private readonly folder: string,
    private readonly onDiagnostics?: (diagnostics: SkillDiagnostic[]) => void,
  ) {}

  async discover(): Promise<SkillDiscovery> {
    const diagnostics: SkillDiagnostic[] = [];
    const parsed: Skill[] = [];
    const prefix = `${this.folder}/Skills/`;
    const files = this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const file of files) {
      const relative = file.path.slice(prefix.length);
      if (!/^[^/]+\/SKILL\.md$/.test(relative)) {
        continue;
      }
      if (parsed.length >= MAX_SKILLS) {
        diagnostics.push({ path: file.path, message: `Skill limit of ${MAX_SKILLS} reached` });
        continue;
      }
      try {
        parsed.push(await this.parse(file, relative.split("/")[0] ?? ""));
      } catch (error) {
        diagnostics.push({ path: file.path, message: describeError(error) });
      }
    }

    const names = new Map<string, Skill[]>();
    for (const skill of parsed) {
      const matches = names.get(skill.name) ?? [];
      matches.push(skill);
      names.set(skill.name, matches);
    }
    this.discovered.clear();
    let catalogChars = 0;
    for (const [name, matches] of names) {
      if (matches.length > 1) {
        for (const skill of matches) {
          diagnostics.push({ path: skill.path, message: `Duplicate skill name: ${name}` });
        }
        continue;
      }
      const skill = matches[0]!;
      const entryChars = skill.name.length + skill.description.length;
      if (catalogChars + entryChars > MAX_CATALOG_CHARS) {
        diagnostics.push({ path: skill.path, message: `Skill catalog exceeds ${MAX_CATALOG_CHARS} characters` });
        continue;
      }
      this.discovered.set(name, skill);
      catalogChars += entryChars;
    }
    diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
    this.report(diagnostics);
    return {
      skills: [...this.discovered.values()].map(({ name, description, path }) => ({ name, description, path })),
      diagnostics,
    };
  }

  async activate(name: string): Promise<ActivatedSkill> {
    await this.discover();
    const skill = this.discovered.get(name);
    if (!skill) {
      throw new Error(`Skill is unavailable: ${name}`);
    }
    return {
      name: skill.name,
      description: skill.description,
      compatibility: skill.compatibility,
      instructions: skill.body,
      resources: [...skill.resources],
    };
  }

  async readResource(name: string, relativePath: string): Promise<string> {
    await this.discover();
    const skill = this.discovered.get(name);
    if (!skill) {
      throw new Error(`Skill is unavailable: ${name}`);
    }
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("Skill resource must be a relative path inside the skill directory");
    }
    if (!skill.resources.includes(normalized)) {
      throw new Error(`Skill resource not found: ${normalized}`);
    }
    const file = this.app.vault.getFileByPath(`${skill.path.slice(0, -"SKILL.md".length)}${normalized}`);
    if (!file) {
      throw new Error(`Skill resource not found: ${normalized}`);
    }
    const content = await this.app.vault.cachedRead(file);
    if (content.length > MAX_RESOURCE_CHARS) {
      throw new Error(`Skill resource exceeds ${MAX_RESOURCE_CHARS} characters`);
    }
    return content;
  }

  private async parse(file: TFile, directory: string): Promise<Skill> {
    const raw = await this.app.vault.cachedRead(file);
    if (raw.length > MAX_SKILL_CHARS) {
      throw new Error(`Skill exceeds ${MAX_SKILL_CHARS} characters`);
    }
    const frontmatter = splitFrontmatter(raw);
    const parsed = parseYaml(frontmatter.yaml) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Skill frontmatter must be a YAML mapping");
    }
    const data = parsed as Record<string, unknown>;
    const name = data.name;
    const description = data.description;
    if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error("Skill name must be 1–64 lowercase letters, numbers, or single hyphens");
    }
    if (name !== directory) {
      throw new Error(`Skill name must match its directory: ${directory}`);
    }
    if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
      throw new Error("Skill description must contain 1–1024 characters");
    }
    validateOptionalFields(data);
    const directoryPath = file.path.slice(0, -"SKILL.md".length);
    const resources = this.app.vault.getFiles()
      .filter((candidate) => candidate.path.startsWith(directoryPath) && candidate.path !== file.path)
      .map((candidate) => candidate.path.slice(directoryPath.length))
      .filter((path) => path.length > 0)
      .sort();
    if (resources.length > MAX_RESOURCES) {
      throw new Error(`Skill has more than ${MAX_RESOURCES} resources`);
    }
    return {
      name,
      description,
      path: file.path,
      body: frontmatter.body,
      compatibility: typeof data.compatibility === "string" ? data.compatibility : undefined,
      resources,
    };
  }

  private report(diagnostics: SkillDiagnostic[]): void {
    const key = JSON.stringify(diagnostics);
    if (key === this.diagnosticKey) {
      return;
    }
    this.diagnosticKey = key;
    this.onDiagnostics?.(diagnostics);
  }
}

function splitFrontmatter(raw: string): { yaml: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new Error("SKILL.md must begin with YAML frontmatter");
  }
  return { yaml: match[1] ?? "", body: (match[2] ?? "").trim() };
}

function validateOptionalFields(data: Record<string, unknown>): void {
  if (data.license !== undefined && typeof data.license !== "string") {
    throw new Error("Skill license must be a string");
  }
  if (data.compatibility !== undefined && (typeof data.compatibility !== "string" || data.compatibility.length < 1 || data.compatibility.length > 500)) {
    throw new Error("Skill compatibility must contain 1–500 characters");
  }
  if (data["allowed-tools"] !== undefined && typeof data["allowed-tools"] !== "string") {
    throw new Error("Skill allowed-tools must be a string");
  }
  if (data.metadata !== undefined) {
    const metadata = data.metadata;
    if (
      typeof metadata !== "object"
      || metadata === null
      || Array.isArray(metadata)
      || Object.values(metadata as Record<string, unknown>).some((value) => typeof value !== "string")
    ) {
      throw new Error("Skill metadata values must be strings");
    }
  }
}


function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
