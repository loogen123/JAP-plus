import { describe, expect, it } from "vitest";
import type { Chunk, RetrievalResult } from "../../rag/types.js";
import { bm25Score } from "../../rag/retrieval/hybridSearch.js";
import { mmrRerank, rrfFuse } from "../../rag/retrieval/reranker.js";

function makeChunk(id: string, content: string): Chunk {
  return {
    id,
    docId: "doc-1",
    kbId: "kb-1",
    content,
    embedding: [],
    metadata: {
      docFileName: "test.md",
      chunkIndex: 0,
      tokenCount: 10,
    },
  };
}

describe("bm25Score", () => {
  it("完全匹配得分更高", () => {
    const doc = makeChunk("1", "用户登录认证模块");
    const score = bm25Score("登录认证", doc.content);
    expect(score).toBeGreaterThan(0.5);
  });

  it("不相关文本得分为 0", () => {
    const doc = makeChunk("2", "系统设置页面");
    const score = bm25Score("支付", doc.content);
    expect(score).toBe(0);
  });
});

describe("rrfFuse", () => {
  it("合并两组排序结果", () => {
    const semantic: RetrievalResult[] = [
      { chunk: makeChunk("a", "登录"), score: 0.9, source: "" },
      { chunk: makeChunk("b", "注册"), score: 0.7, source: "" },
    ];
    const keyword: RetrievalResult[] = [
      { chunk: makeChunk("b", "注册"), score: 0.8, source: "" },
      { chunk: makeChunk("c", "设置"), score: 0.5, source: "" },
    ];
    const fused = rrfFuse(semantic, keyword);
    expect(fused[0]?.chunk.id).toBe("b");
    expect(fused.length).toBe(3);
  });
});

describe("mmrRerank", () => {
  it("控制结果数量", () => {
    const results: RetrievalResult[] = [
      { chunk: makeChunk("a", "登录认证机制设计"), score: 0.95, source: "" },
      { chunk: makeChunk("b", "登录页面UI设计"), score: 0.85, source: "" },
      { chunk: makeChunk("c", "数据库索引优化"), score: 0.75, source: "" },
    ];
    const reranked = mmrRerank(results, 2, 0.7);
    expect(reranked.length).toBeLessThanOrEqual(2);
  });
});
