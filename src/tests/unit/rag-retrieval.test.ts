import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chunk, RetrievalResult } from "../../rag/types.js";
import { cosineSimilarity, embedChunks, tokenize } from "../../rag/embedding/index.js";
import { bm25Score } from "../../rag/retrieval/hybridSearch.js";
import {
  expandQueries,
  mergeRetrievalResults,
  resolveCandidatePoolSize,
  takeTopResults,
} from "../../rag/retrieval/index.js";
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

function makeResult(
  id: string,
  content: string,
  score: number,
  docId: string = "doc-1",
  kbId: string = "kb-1",
  kbName: string = "知识库A",
): RetrievalResult {
  return {
    chunk: makeChunk(id, content, docId),
    score,
    source: docId,
    kbId,
    kbName,
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
      makeResult("a", "登录", 0.9),
      makeResult("b", "注册", 0.7),
    ];
    const keyword: RetrievalResult[] = [
      makeResult("b", "注册", 0.8),
      makeResult("c", "设置", 0.5),
    ];
    const fused = rrfFuse(semantic, keyword);
    expect(fused[0]?.chunk.id).toBe("b");
    expect(fused.length).toBe(3);
  });
});

describe("mmrRerank", () => {
  it("控制结果数量", () => {
    const results: RetrievalResult[] = [
      makeResult("a", "登录认证机制设计", 0.95),
      makeResult("b", "登录页面UI设计", 0.85),
      makeResult("c", "数据库索引优化", 0.75),
    ];
    const reranked = mmrRerank(results, 2, 0.7);
    expect(reranked.length).toBeLessThanOrEqual(2);
  });
});

describe("takeTopResults", () => {
  it("允许同一文档返回多个高分块", () => {
    const results: RetrievalResult[] = [
      makeResult("a", "登录设计", 0.95, "doc-1"),
      makeResult("b", "登录接口", 0.9, "doc-1"),
      makeResult("c", "系统设置", 0.6, "doc-2"),
    ];

    const ranked = takeTopResults(results, 2);
    expect(ranked.map((item) => item.chunk.id)).toEqual(["a", "b"]);
  });

  it("按全局分数顺序截断 topK", () => {
    const results: RetrievalResult[] = [
      makeResult("a", "A", 0.81, "doc-1"),
      makeResult("b", "B", 0.79, "doc-2"),
      makeResult("c", "C", 0.78, "doc-1"),
    ];

    const ranked = takeTopResults(results, 2);
    expect(ranked.map((item) => item.chunk.id)).toEqual(["a", "b"]);
  });
});

describe("mergeRetrievalResults", () => {
  it("合并多库结果并保留知识库来源", () => {
    const merged = mergeRetrievalResults(
      [
        [
          makeResult("a", "登录设计", 0.81, "doc-1", "kb-1", "知识库A"),
        ],
        [
          makeResult("b", "接口契约", 0.92, "doc-2", "kb-2", "知识库B"),
        ],
      ],
      5,
    );

    expect(merged.map((item) => item.chunk.id)).toEqual(["b", "a"]);
    expect(merged[0]?.kbName).toBe("知识库B");
    expect(merged[1]?.kbId).toBe("kb-1");
  });

  it("按 chunk 去重并保留更高分结果", () => {
    const merged = mergeRetrievalResults(
      [
        [
          makeResult("a", "登录设计", 0.61, "doc-1", "kb-1", "知识库A"),
        ],
        [
          makeResult("a", "登录设计", 0.88, "doc-1", "kb-2", "知识库B"),
        ],
      ],
      5,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.score).toBe(0.88);
    expect(merged[0]?.kbName).toBe("知识库B");
  });

  it("跨库不同 chunk.id 但同 source 和 content 时按更高分去重", () => {
    const merged = mergeRetrievalResults(
      [
        [
          makeResult("a-1", "登录设计", 0.61, "shared-doc", "kb-1", "知识库A"),
        ],
        [
          makeResult("b-9", "登录设计", 0.88, "shared-doc", "kb-2", "知识库B"),
        ],
      ],
      5,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.chunk.id).toBe("b-9");
    expect(merged[0]?.score).toBe(0.88);
    expect(merged[0]?.kbName).toBe("知识库B");
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
      makeResult("a", "A", 0.95, "doc-1"),
      makeResult("b", "B", 0.94, "doc-1"),
      makeResult("c", "C", 0.9, "doc-2"),
    ];

    const diversified = applySoftDiversification(results, 0.92);
    expect(diversified).toHaveLength(3);
    expect(diversified[0]?.chunk.id).toBe("a");
    expect(diversified.some((item) => item.chunk.id === "c")).toBe(true);
    expect((diversified.find((item) => item.chunk.id === "b")?.score ?? 0)).toBeLessThan(0.94);
  });
});

describe("RAGService multi-kb", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("单库失败时跳过失败库并返回其他库结果", async () => {
    const kbManagerMocks = {
      addDocumentToIndex: vi.fn(),
      loadDocsIndex: vi.fn(),
      removeDocumentFromIndex: vi.fn(),
      updateKBStats: vi.fn(),
      listKnowledgeBases: vi.fn(),
      createKnowledgeBase: vi.fn(),
      getKnowledgeBase: vi.fn(async (kbId: string) => {
        if (kbId === "kb-1") {
          return { id: "kb-1", name: "知识库A" };
        }
        if (kbId === "kb-2") {
          return { id: "kb-2", name: "知识库B" };
        }
        return null;
      }),
      deleteKnowledgeBase: vi.fn(),
    };
    const retrievalMocks = {
      clearStoreCache: vi.fn(),
      retrieve: vi.fn(async (_query: string, kbId: string) => {
        if (kbId === "kb-1") {
          throw new Error("retrieve failed");
        }
        return [
          {
            chunk: {
              id: "chunk-2",
              docId: "doc-2",
              kbId: "kb-2",
              content: "接口契约",
              embedding: [],
              metadata: {
                docFileName: "doc-2.md",
                chunkIndex: 0,
                tokenCount: 10,
              },
            },
            score: 0.91,
            source: "doc-2.md",
            kbId: "kb-2",
            kbName: "",
          },
        ];
      }),
      mergeRetrievalResults: vi.fn((groups: RetrievalResult[][], topK: number) =>
        groups.flat().sort((a, b) => b.score - a.score).slice(0, topK),
      ),
    };

    vi.doMock("../../rag/kbManager.js", () => kbManagerMocks);
    vi.doMock("../../rag/retrieval/index.js", () => retrievalMocks);

    const { RAGService } = await import("../../rag/index.js");
    const service = new RAGService();
    const results = await service.retrieveAcrossKnowledgeBases(
      "接口",
      ["kb-1", "kb-2"],
      { baseURL: "", apiKey: "" },
      { topK: 5 },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.kbId).toBe("kb-2");
    expect(results[0]?.kbName).toBe("知识库B");
  });
});
