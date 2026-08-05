export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

export class TFile {}
export class TFolder {}


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