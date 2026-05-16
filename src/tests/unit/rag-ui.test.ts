import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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

type FetchMock = (url: string, options?: Record<string, unknown>) => Promise<{
  ok: boolean;
  json: () => Promise<Record<string, unknown>>;
}>;

function createJsonResponse(data: unknown, ok = true): {
  ok: boolean;
  json: () => Promise<Record<string, unknown>>;
} {
  return {
    ok,
    json: async () => (ok ? { code: 0, data } : { code: 1, message: "request failed" }),
  };
}

async function loadRagRuntime(fetchImpl?: FetchMock): Promise<{
  window: Record<string, any>;
  document: FakeDocument;
}> {
  const raw = await readProjectFile("public/js/ragModal.js");
  const script = raw.replace(
    '  window.RAG_MODAL = {\n    open,\n    close,\n  };\n})();',
    '  window.RAG_MODAL = {\n    open,\n    close,\n  };\n  window.__RAG_TEST__ = { openChunkPreview, selectKb, toggleBindingKb, bindCurrentRun, getState: () => state };\n})();',
  );
  const window = {} as Record<string, any>;
  const appState = { runtime: { currentRunState: null as Record<string, unknown> | null } };
  window.JapAppState = {
    getState: () => appState,
  };
  const document = new FakeDocument();
  const run = new Function("window", "document", "fetch", "btoa", "requestAnimationFrame", "setTimeout", script);
  run(
    window,
    document,
    fetchImpl ?? (async () => createJsonResponse([])),
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
  window.__RAG_TEST__.setCurrentRunState = (value: Record<string, unknown> | null) => {
    appState.runtime.currentRunState = value;
  };
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
          parentFullContext: "步骤说明。\n\n写一句核心价值主张。\n\n范围文档。",
        },
      },
    });
    expect(document.getElementById("ragChunkOpenSource")).not.toBeNull();
    expect(document.getElementById("ragChunkMeta")?.innerHTML).toContain("章节路径");
    expect(document.getElementById("ragChunkMeta")?.innerHTML).toContain("手册 &gt; 步骤 1：定义 MVP 边界");
    expect(document.getElementById("ragChunkParentContext")?.textContent).toContain("写一句核心价值主张。");
    expect(document.getElementById("ragChunkParentContext")?.textContent).toContain("范围文档。");
  });

  it("运行时把父级上下文和子块内容拆成上下分栏独立区域", async () => {
    const { window, document } = await loadRagRuntime();
    window.__RAG_TEST__.openChunkPreview({
      score: 0.86,
      chunk: {
        content: "子模块内容",
        metadata: {
          docFileName: "guide.md",
          chunkIndex: 1,
          lineRange: [3, 8],
          path: ["手册", "步骤 1：定义 MVP 边界"],
          parentKind: "section",
          parentTitle: "步骤 1：定义 MVP 边界",
          parentFullContext: "父模块完整内容",
        },
      },
    });
    expect(document.getElementById("ragChunkParentPanel")).not.toBeNull();
    expect(document.getElementById("ragChunkParentContext")?.textContent).toBe("父模块完整内容");
    expect(document.getElementById("ragChunkContent")?.textContent).toBe("子模块内容");
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

  it("绑定当前任务时支持多选且保留当前查看知识库", async () => {
    const fetchMock = vi.fn<FetchMock>(async (url, options) => {
      if (url === "/api/v1/rag/knowledge-bases") {
        return createJsonResponse([
          { id: "kb-a", name: "知识库 A", documentCount: 1, chunkCount: 2 },
          { id: "kb-b", name: "知识库 B", documentCount: 3, chunkCount: 5 },
        ]);
      }
      if (url === "/api/v1/rag/knowledge-bases/kb-a") {
        return createJsonResponse({
          id: "kb-a",
          name: "知识库 A",
          documentCount: 1,
          chunkCount: 2,
          documents: [{ id: "doc-a", fileName: "a.md", fileType: "md" }],
        });
      }
      if (url === "/api/v1/rag/knowledge-bases/kb-b") {
        return createJsonResponse({
          id: "kb-b",
          name: "知识库 B",
          documentCount: 3,
          chunkCount: 5,
          documents: [{ id: "doc-b", fileName: "b.md", fileType: "md" }],
        });
      }
      if (url === "/api/v1/tasks/filewise/run-1/rag" && options?.method === "PATCH") {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { window, document } = await loadRagRuntime(fetchMock);
    const currentTaskId = document.createElement();
    currentTaskId.id = "currentTaskId";
    currentTaskId.textContent = "run-1";
    document.body.appendChild(currentTaskId);
    const workspacePath = document.createElement();
    workspacePath.id = "workspacePath";
    workspacePath.value = "D:/demo";
    document.body.appendChild(workspacePath);
    window.__RAG_TEST__.setCurrentRunState({ runId: "run-1", ragKbIds: ["kb-a"] });

    await window.RAG_MODAL.open();
    await window.__RAG_TEST__.selectKb("kb-a");
    window.__RAG_TEST__.toggleBindingKb("kb-b");

    expect(window.__RAG_TEST__.getState().selectedKb?.id).toBe("kb-a");
    expect(window.__RAG_TEST__.getState().bindingKbIds).toEqual(["kb-a", "kb-b"]);
    expect(document.getElementById("ragKbMetaLine")?.textContent).toContain("知识库 A");
    expect(document.getElementById("ragBindMetaLine")?.textContent).toContain("2");

    const bindPromise = window.__RAG_TEST__.bindCurrentRun();
    await Promise.resolve();
    await Promise.resolve();
    document.getElementById("ragFeedbackOk")?.dispatchEvent({ type: "click" });
    await bindPromise;

    const patchCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/v1/tasks/filewise/run-1/rag" && options?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      ragKbIds: ["kb-a", "kb-b"],
      workspace: { path: "D:/demo" },
    });
  });

  it("切换任务后重新打开弹窗不会沿用上一个任务的绑定选择", async () => {
    const fetchMock = vi.fn<FetchMock>(async (url) => {
      if (url === "/api/v1/rag/knowledge-bases") {
        return createJsonResponse([
          { id: "kb-a", name: "知识库 A", documentCount: 1, chunkCount: 2 },
          { id: "kb-b", name: "知识库 B", documentCount: 3, chunkCount: 5 },
        ]);
      }
      if (url === "/api/v1/rag/knowledge-bases/kb-a") {
        return createJsonResponse({
          id: "kb-a",
          name: "知识库 A",
          documentCount: 1,
          chunkCount: 2,
          documents: [{ id: "doc-a", fileName: "a.md", fileType: "md" }],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { window, document } = await loadRagRuntime(fetchMock);
    const currentTaskId = document.createElement();
    currentTaskId.id = "currentTaskId";
    currentTaskId.textContent = "run-1";
    document.body.appendChild(currentTaskId);
    window.__RAG_TEST__.setCurrentRunState({ runId: "run-1", ragKbIds: ["kb-a"] });

    await window.RAG_MODAL.open();
    expect(window.__RAG_TEST__.getState().bindingKbIds).toEqual(["kb-a"]);

    window.RAG_MODAL.close();
    currentTaskId.textContent = "run-2";
    window.__RAG_TEST__.setCurrentRunState({ runId: "run-2", ragKbIds: [] });
    await window.RAG_MODAL.open();

    expect(window.__RAG_TEST__.getState().bindingKbIds).toEqual([]);
    expect(document.getElementById("ragBindMetaLine")?.textContent).toContain("0");
  });

  it("弹窗保持打开时切换任务不会复用旧绑定选择", async () => {
    const fetchMock = vi.fn<FetchMock>(async (url, options) => {
      if (url === "/api/v1/rag/knowledge-bases") {
        return createJsonResponse([
          { id: "kb-a", name: "知识库 A", documentCount: 1, chunkCount: 2 },
          { id: "kb-b", name: "知识库 B", documentCount: 3, chunkCount: 5 },
        ]);
      }
      if (url === "/api/v1/tasks/filewise/run-2/rag" && options?.method === "PATCH") {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { window, document } = await loadRagRuntime(fetchMock);
    const currentTaskId = document.createElement();
    currentTaskId.id = "currentTaskId";
    currentTaskId.textContent = "run-1";
    document.body.appendChild(currentTaskId);
    const workspacePath = document.createElement();
    workspacePath.id = "workspacePath";
    workspacePath.value = "D:/demo";
    document.body.appendChild(workspacePath);
    window.__RAG_TEST__.setCurrentRunState({ runId: "run-1", ragKbIds: ["kb-a"] });

    await window.RAG_MODAL.open();
    expect(window.__RAG_TEST__.getState().bindingKbIds).toEqual(["kb-a"]);

    currentTaskId.textContent = "run-2";
    window.__RAG_TEST__.setCurrentRunState({ runId: "run-2", ragKbIds: [] });
    window.__RAG_TEST__.toggleBindingKb("kb-b");
    expect(window.__RAG_TEST__.getState().bindingKbIds).toEqual(["kb-b"]);

    const bindPromise = window.__RAG_TEST__.bindCurrentRun();
    await Promise.resolve();
    await Promise.resolve();
    document.getElementById("ragFeedbackOk")?.dispatchEvent({ type: "click" });
    await bindPromise;

    const patchCall = fetchMock.mock.calls.find(
      ([url, requestOptions]) => url === "/api/v1/tasks/filewise/run-2/rag" && requestOptions?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      ragKbIds: ["kb-b"],
      workspace: { path: "D:/demo" },
    });
  });

  it("没有选中知识库时允许提交空数组以解绑全部", async () => {
    const fetchMock = vi.fn<FetchMock>(async (url, options) => {
      if (url === "/api/v1/rag/knowledge-bases") {
        return createJsonResponse([
          { id: "kb-a", name: "知识库 A", documentCount: 1, chunkCount: 2 },
        ]);
      }
      if (url === "/api/v1/tasks/filewise/run-1/rag" && options?.method === "PATCH") {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { window, document } = await loadRagRuntime(fetchMock);
    const currentTaskId = document.createElement();
    currentTaskId.id = "currentTaskId";
    currentTaskId.textContent = "run-1";
    document.body.appendChild(currentTaskId);
    const workspacePath = document.createElement();
    workspacePath.id = "workspacePath";
    workspacePath.value = "D:/demo";
    document.body.appendChild(workspacePath);
    window.__RAG_TEST__.setCurrentRunState({ runId: "run-1", ragKbIds: ["kb-a"] });

    await window.RAG_MODAL.open();
    window.__RAG_TEST__.toggleBindingKb("kb-a");
    expect(window.__RAG_TEST__.getState().bindingKbIds).toEqual([]);

    const bindPromise = window.__RAG_TEST__.bindCurrentRun();
    await Promise.resolve();
    await Promise.resolve();
    document.getElementById("ragFeedbackOk")?.dispatchEvent({ type: "click" });
    await bindPromise;

    const patchCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/v1/tasks/filewise/run-1/rag" && options?.method === "PATCH",
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      ragKbIds: [],
      workspace: { path: "D:/demo" },
    });
  });
});
