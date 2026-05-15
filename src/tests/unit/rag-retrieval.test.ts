import { describe, expect, it } from "vitest";
import type { Chunk, RetrievalResult } from "../../rag/types.js";
import { cosineSimilarity, embedChunks, tokenize } from "../../rag/embedding/index.js";
import { bm25Score } from "../../rag/retrieval/hybridSearch.js";
import { expandQueries, resolveCandidatePoolSize, takeTopResults } from "../../rag/retrieval/index.js";
import { applySoftDiversification, mmrRerank, rrfFuse } from "../../rag/retrieval/reranker.js";

function makeChunk(id: string, content: string, docId: string = "doc-1"): Chunk {
  return {
    id,
    docId,
    kbId: "kb-1",
    content,
    embedding: [],
    metadata: {
      docFileName: `${docId}.md`,
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

describe("tokenize", () => {
  it("为中文短语补充 bigram token", () => {
    const tokens = tokenize("工作树隔离");
    expect(tokens).toContain("工作");
    expect(tokens).toContain("树隔");
    expect(tokens).toContain("隔离");
  });
});

describe("embedChunks fallback", () => {
  it("无 API 时同主题文本相似度高于无关文本", async () => {
    const apiConfig = { baseURL: "", apiKey: "" };
    const docA = (await embedChunks([{ id: "a", content: "harness worktree agent runtime" }], apiConfig)).get("a");
    const docB = (await embedChunks([{ id: "b", content: "invoice payment ledger finance" }], apiConfig)).get("b");
    const query = (await embedChunks([{ id: "q", content: "harness worktree" }], apiConfig)).get("q");

    expect(docA).toBeDefined();
    expect(docB).toBeDefined();
    expect(query).toBeDefined();
    expect(cosineSimilarity(query ?? [], docA ?? [])).toBeGreaterThan(cosineSimilarity(query ?? [], docB ?? []));
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

describe("takeTopResults", () => {
  it("允许同一文档返回多个高分块", () => {
    const results: RetrievalResult[] = [
      { chunk: makeChunk("a", "登录设计", "doc-1"), score: 0.95, source: "" },
      { chunk: makeChunk("b", "登录接口", "doc-1"), score: 0.9, source: "" },
      { chunk: makeChunk("c", "系统设置", "doc-2"), score: 0.6, source: "" },
    ];

    const ranked = takeTopResults(results, 2);
    expect(ranked.map((item) => item.chunk.id)).toEqual(["a", "b"]);
  });

  it("按全局分数顺序截断 topK", () => {
    const results: RetrievalResult[] = [
      { chunk: makeChunk("a", "A", "doc-1"), score: 0.81, source: "" },
      { chunk: makeChunk("b", "B", "doc-2"), score: 0.79, source: "" },
      { chunk: makeChunk("c", "C", "doc-1"), score: 0.78, source: "" },
    ];

    const ranked = takeTopResults(results, 2);
    expect(ranked.map((item) => item.chunk.id)).toEqual(["a", "b"]);
  });
});

describe("expandQueries", () => {
  it("为中英文混合术语生成有限查询扩展", () => {
    const rewrites = expandQueries("Quest worktree 并行开发", 3);
    expect(rewrites[0]).toBe("Quest worktree 并行开发");
    expect(rewrites.length).toBeLessThanOrEqual(3);
    expect(rewrites.some((item) => item.includes("worktree"))).toBe(true);
    expect(new Set(rewrites).size).toBe(rewrites.length);
  });
});

describe("resolveCandidatePoolSize", () => {
  it("按固定下限和倍率放大候选池", () => {
    expect(resolveCandidatePoolSize(5, undefined, undefined)).toBe(40);
    expect(resolveCandidatePoolSize(2, undefined, undefined)).toBe(20);
    expect(resolveCandidatePoolSize(4, 6, 30)).toBe(30);
  });
});

describe("applySoftDiversification", () => {
  it("对同文档连续命中做轻量衰减而不是硬裁剪", () => {
    const results: RetrievalResult[] = [
      { chunk: makeChunk("a", "A", "doc-1"), score: 0.95, source: "doc-1" },
      { chunk: makeChunk("b", "B", "doc-1"), score: 0.94, source: "doc-1" },
      { chunk: makeChunk("c", "C", "doc-2"), score: 0.9, source: "doc-2" },
    ];

    const diversified = applySoftDiversification(results, 0.92);
    expect(diversified).toHaveLength(3);
    expect(diversified[0]?.chunk.id).toBe("a");
    expect(diversified.some((item) => item.chunk.id === "c")).toBe(true);
    expect((diversified.find((item) => item.chunk.id === "b")?.score ?? 0)).toBeLessThan(0.94);
  });
});
