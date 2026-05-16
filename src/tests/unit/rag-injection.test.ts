import { describe, expect, it } from "vitest";
import type { RetrievalResult } from "../../rag/types.js";
import { buildRAGPrompt } from "../../rag/injection/index.js";

function makeResult(id: string, content: string, score: number, source: string): RetrievalResult {
  return {
    chunk: {
      id,
      docId: "doc-1",
      kbId: "kb-1",
      content,
      embedding: [],
      metadata: {
        docFileName: source,
        chunkIndex: 0,
        tokenCount: 20,
      },
    },
    score,
    source,
    kbId: "kb-1",
    kbName: "技术文档",
  };
}

describe("buildRAGPrompt", () => {
  it("空结果返回空字符串", () => {
    expect(buildRAGPrompt([])).toBe("");
  });

  it("单结果包含引用来源", () => {
    const results = [makeResult("1", "JWT Token 有效期 2 小时", 0.92, "auth-spec.md")];
    const prompt = buildRAGPrompt(results);
    expect(prompt).toContain("参考知识");
    expect(prompt).toContain("技术文档");
    expect(prompt).toContain("auth-spec.md");
    expect(prompt).toContain("0.92");
    expect(prompt).toContain("JWT Token");
  });

  it("多结果按分数排序", () => {
    const results = [makeResult("1", "内容A", 0.5, "doc-a.md"), makeResult("2", "内容B", 0.95, "doc-b.md")];
    const prompt = buildRAGPrompt(results);
    const idxA = prompt.indexOf("内容A");
    const idxB = prompt.indexOf("内容B");
    expect(idxB).toBeLessThan(idxA);
  });

  it("多库结果展示多个知识库名", () => {
    const results = [
      makeResult("1", "内容A", 0.7, "doc-a.md"),
      {
        ...makeResult("2", "内容B", 0.9, "doc-b.md"),
        kbId: "kb-2",
        kbName: "接口规范库",
      },
    ];
    const prompt = buildRAGPrompt(results);
    expect(prompt).toContain("技术文档");
    expect(prompt).toContain("接口规范库");
  });
});
