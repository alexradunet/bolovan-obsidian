import { describe, expect, it } from "vitest";
import { BolovanChatView } from "../src/chat-view";
import type { TranscriptToolItem } from "../src/transcript";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  parent: FakeElement | undefined;

  constructor(
    readonly tag = "div",
    readonly className = "",
    readonly text = "",
  ) {}

  querySelector(selector: string): FakeElement | null {
    const className = selector.startsWith(".") ? selector.slice(1) : "";
    for (const child of this.children) {
      if (child.className.split(" ").includes(className)) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  createDiv(options: { cls?: string } = {}): FakeElement {
    return this.createEl("div", options);
  }

  createEl(tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}): FakeElement {
    const child = new FakeElement(tag, options.cls, options.text);
    child.parent = this;
    for (const [name, value] of Object.entries(options.attr ?? {})) {
      child.attributes.set(name, value);
    }
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  click(): void {
    this.listeners.get("click")?.();
  }

  remove(): void {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
  }
}

describe("web read actions", () => {
  it("opens a web URL without sending it through vault link resolution", () => {
    const app = {
      workspace: {
        openLinkText(): never {
          throw new Error("File name cannot contain any of the following characters: \\ / :");
        },
      },
    };
    const view = new BolovanChatView({ app } as never, {} as never);
    const root = new FakeElement();
    const item: TranscriptToolItem = {
      id: "web-1",
      kind: "tool",
      name: "web_read",
      target: "https://example.com/article",
      status: "done",
    };

    const paintWebActions = view as unknown as {
      paintWebActions(item: TranscriptToolItem, el: HTMLElement): void;
    };
    paintWebActions.paintWebActions(item, root as unknown as HTMLElement);
    const actions = root.querySelector(".bolovan-tool__actions");
    const open = actions?.children[1];

    expect(() => open?.click()).not.toThrow();
    expect(open?.tag).toBe("a");
    expect(open?.attributes.get("href")).toBe("https://example.com/article");
  });
});
