export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

export class TFile {}
export class TFolder {}
export class MarkdownView {
  constructor(public readonly leaf: unknown) {}
}

export function getAllTags(cache: {
  tags?: Array<{ tag: string }>;
  frontmatter?: Record<string, unknown>;
}): string[] | null {
  const tags = cache.tags?.map((item) => item.tag) ?? [];
  const frontmatterTags = cache.frontmatter?.tags;
  if (typeof frontmatterTags === "string") {
    tags.push(...frontmatterTags.split(/\s+/).filter(Boolean).map((tag) => tag.startsWith("#") ? tag : `#${tag}`));
  } else if (Array.isArray(frontmatterTags)) {
    tags.push(...frontmatterTags.map(String).map((tag) => tag.startsWith("#") ? tag : `#${tag}`));
  }
  return tags.length ? [...new Set(tags)] : null;
}

export function resolveSubpath(
  cache: {
    headings?: Array<{
      heading: string;
      level: number;
      position: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } };
    }>;
    blocks?: Record<string, {
      id: string;
      position: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } };
    }>;
  },
  subpath: string,
): { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } | null } | null {
  if (subpath.startsWith("#^")) {
    const block = cache.blocks?.[subpath.slice(2)];
    return block ? { start: block.position.start, end: block.position.end } : null;
  }
  const wanted = decodeURIComponent(subpath.slice(1)).toLocaleLowerCase();
  const headings = cache.headings ?? [];
  const index = headings.findIndex((heading) => heading.heading.toLocaleLowerCase() === wanted);
  const current = headings[index];
  if (!current) {
    return null;
  }
  const next = headings.slice(index + 1).find((heading) => heading.level <= current.level);
  return { start: current.position.start, end: next?.position.start ?? null };
}


export class ItemView {
  app: unknown;

  constructor(leaf: { app?: unknown }) {
    this.app = leaf.app;
  }
}

export class FuzzySuggestModal<T> {}
export class Modal {}
export class Notice {}

export const MarkdownRenderer = {
  render: async (): Promise<void> => undefined,
};

export function setIcon(): void {}