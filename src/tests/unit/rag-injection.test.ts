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
  };
}

describe("buildRAGPrompt", () => {
  it("空结果返回空字符串", () => {
    expect(buildRAGPrompt([], "测试库")).toBe("");
  });

  it("单结果包含引用来源", () => {
    const results = [makeResult("1", "JWT Token 有效期 2 小时", 0.92, "auth-spec.md")];
    const prompt = buildRAGPrompt(results, "技术文档");
    expect(prompt).toContain("参考知识");
    expect(prompt).toContain("技术文档");
    expect(prompt).toContain("auth-spec.md");
    expect(prompt).toContain("0.92");
    expect(prompt).toContain("JWT Token");
  });

  it("多结果按分数排序", () => {
    const results = [makeResult("1", "内容A", 0.5, "doc-a.md"), makeResult("2", "内容B", 0.95, "doc-b.md")];
    const prompt = buildRAGPrompt(results, "库");
    const idxA = prompt.indexOf("内容A");
    const idxB = prompt.indexOf("内容B");
    expect(idxB).toBeLessThan(idxA);
  });
});
