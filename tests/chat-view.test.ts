import { describe, expect, it } from "vitest";
import { BolovanChatView } from "../src/chat-view";
import type { TranscriptToolItem } from "../src/transcript";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  parent: FakeElement | undefined;
  className: string;
  text: string;
  disabled = false;
  scrollHeight = 0;
  scrollTop = 0;

  constructor(
    readonly tag = "div",
    className = "",
    text = "",
  ) {
    this.className = className;
    this.text = text;
  }

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
  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (selector === child.tag) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }


  createDiv(options: { cls?: string } = {}): FakeElement {
    return this.createEl("div", options);
  }
  createSpan(options: { cls?: string; text?: string } = {}): FakeElement {
    return this.createEl("span", options);
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
  setAttr(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  setText(text: string): void {
    this.text = text;
  }

  addClass(className: string): void {
    this.className = `${this.className} ${className}`.trim();
  }

  focus(): void {}


  click(): void {
    this.listeners.get("click")?.();
  }

  remove(): void {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
  }
}

describe("change approvals", () => {
  it("renders a long preview inline, offers full-screen inspection, and answers once", () => {
    const responses: Array<{ id: string; approved: boolean }> = [];
    const plugin = {
      agent: {
        respondApproval(id: string, approved: boolean): void {
          responses.push({ id, approved });
        },
      },
    };
    const view = new BolovanChatView({ app: {} } as never, plugin as never);
    const transcript = new FakeElement();
    const privateView = view as unknown as {
      transcriptEl: HTMLElement;
      showApproval(request: { id: string; title: string; message: string }): void;
    };
    privateView.transcriptEl = transcript as unknown as HTMLElement;

    privateView.showApproval({
      id: "approval-1",
      title: "Replace Long note.md",
      message: "Exact approved operation\n\nREPLACE\nLong note.md\n\n" + "content\n".repeat(500),
    });

    const card = transcript.querySelector(".bolovan-approval");
    const preview = card?.querySelector(".bolovan-approval__preview");
    const inspection = card?.querySelector(".bolovan-approval__inspection");
    const actions = card?.querySelector(".bolovan-approval__actions");
    expect(preview?.text.length).toBeLessThanOrEqual(2_000);
    expect(inspection?.querySelectorAll("button")[0]?.text).toBe("Full-screen");

    actions?.querySelectorAll("button")[1]?.click();
    actions?.querySelectorAll("button")[1]?.click();

    expect(responses).toEqual([{ id: "approval-1", approved: true }]);
    expect(actions?.querySelector(".bolovan-approval__status")?.text).toBe("Approved");
    expect(actions?.querySelectorAll("button").every((button) => button.disabled)).toBe(true);
  });
});

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
