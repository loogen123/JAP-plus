import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readProjectFile(relativePath: string): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), relativePath), "utf-8");
}

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.delete(token);
    }
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<string, Array<(event: any) => void>>();
  private readonly owner: FakeDocument;
  private elementId = "";
  private html = "";
  private text = "";
  className = "";
  disabled = false;
  value = "";

  constructor(owner: FakeDocument) {
    this.owner = owner;
  }

  get id(): string {
    return this.elementId;
  }

  set id(value: string) {
    this.elementId = value;
    if (value) {
      this.owner.register(this);
    }
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.text = "";
    this.html = value;
    const matches = value.matchAll(/id="([^"]+)"/g);
    for (const match of matches) {
      const child = new FakeElement(this.owner);
      child.id = match[1] ?? "";
      this.children.push(child);
    }
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    if (child.id) {
      this.owner.register(child);
    }
    return child;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value ?? "");
    this.html = this.text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    const row = this.listeners.get(type) ?? [];
    row.push(handler);
    this.listeners.set(type, row);
  }

  dispatchEvent(event: any): void {
    for (const handler of this.listeners.get(event?.type) ?? []) {
      handler(event);
    }
  }

  querySelector(): FakeElement | null {
    return null;
  }

  closest(selector: string): FakeElement | null {
    if (selector === "[data-action]" && this.dataset.action) {
      return this;
    }
    return null;
  }

  getAttribute(name: string): string | null {
    if (name === "data-action") {
      return this.dataset.action ?? null;
    }
    if (name.startsWith("data-")) {
      return this.dataset[name.slice(5)] ?? null;
    }
    return null;
  }

  setAttribute(name: string, value: string): void {
    if (name === "id") {
      this.id = value;
      return;
    }
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5)] = value;
    }
  }
}

class FakeDocument {
  readonly body = new FakeElement(this);
  private readonly elements = new Map<string, FakeElement>();
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  createElement(): FakeElement {
    return new FakeElement(this);
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    const row = this.listeners.get(type) ?? [];
    row.push(handler);
    this.listeners.set(type, row);
  }

  dispatchEvent(event: any): void {
    for (const handler of this.listeners.get(event?.type) ?? []) {
      handler(event);
    }
  }

  register(element: FakeElement): void {
    this.elements.set(element.id, element);
  }
}

async function loadRagRuntime(): Promise<{
  window: Record<string, any>;
  document: FakeDocument;
}> {
  const raw = await readProjectFile("public/js/ragModal.js");
  const script = raw.replace(
    '  window.RAG_MODAL = {\n    open,\n    close,\n  };\n})();',
    '  window.RAG_MODAL = {\n    open,\n    close,\n  };\n  window.__RAG_TEST__ = { openChunkPreview };\n})();',
  );
  const window = {} as Record<string, any>;
  const document = new FakeDocument();
  const run = new Function("window", "document", "fetch", "btoa", "requestAnimationFrame", "setTimeout", script);
  run(
    window,
    document,
    async () => ({ ok: true, json: async () => ({ code: 0, data: [] }) }),
    (input: string) => Buffer.from(input, "binary").toString("base64"),
    (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    (callback: () => void) => {
      callback();
      return 0;
    },
  );
  return { window, document };
}

describe("RAG UI", () => {
  it("首页不再引用不存在的 tailwindcdn vendor 脚本", async () => {
    const html = await readProjectFile("public/index.html");
    expect(html).not.toContain("/vendor/tailwindcdn.js");
  });

  it("运行时展示 metadata.path 且提供打开源文件按钮", async () => {
    const { window, document } = await loadRagRuntime();
    window.__RAG_TEST__.openChunkPreview({
      score: 0.86,
      chunk: {
        content: "命中内容",
        metadata: {
          docFileName: "guide.md",
          chunkIndex: 1,
          lineRange: [3, 8],
          path: ["手册", "步骤 1：定义 MVP 边界"],
          parentKind: "section",
          parentTitle: "步骤 1：定义 MVP 边界",
          parentContext: "步骤说明。",
        },
      },
    });
    expect(document.getElementById("ragChunkOpenSource")).not.toBeNull();
    expect(document.getElementById("ragChunkMeta")?.innerHTML).toContain("章节路径");
    expect(document.getElementById("ragChunkMeta")?.innerHTML).toContain("手册 &gt; 步骤 1：定义 MVP 边界");
  });

  it("运行时对缺失 parentKind 安全降级为未知", async () => {
    const { window, document } = await loadRagRuntime();
    window.__RAG_TEST__.openChunkPreview({
      score: 0.52,
      chunk: {
        content: "命中内容",
        metadata: {
          docFileName: "essay.md",
          chunkIndex: 0,
          lineRange: [1, 2],
          path: ["随笔"],
          parentTitle: "未命名片段 1",
          parentContext: "第一段",
        },
      },
    });
    expect(document.getElementById("ragChunkMeta")?.innerHTML).toContain("父块类型");
    expect(document.getElementById("ragChunkMeta")?.innerHTML).toContain("未知");
    expect(document.getElementById("ragChunkMeta")?.innerHTML).not.toContain("章节父块");
  });
});
