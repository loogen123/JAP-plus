# RAG Top 4 Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提升 RAG 的检索命中率，优先完成候选池放大、父子块分块、soft diversification 和 query rewrite 四项改造。

**Architecture:** 分块阶段从单层结构块升级为“父章节块 + 子检索块”，让向量召回使用更细粒度的子块，同时保留父级上下文供注入阶段展示。检索阶段扩大 dense / BM25 候选池，保留 RRF 和 MMR，再在最终截断前加入轻量文档衰减与查询扩展，避免单文档相邻块过早霸榜并提高术语变体命中率。

**Tech Stack:** TypeScript, Node.js, Vitest

---

## File Map

- Modify: `src/rag/types.ts`
  - 扩展分块元数据、检索选项和查询扩展类型
- Modify: `src/rag/chunking/index.ts`
  - 把当前单层结构块改成父子块分块输出
- Modify: `src/rag/retrieval/index.ts`
  - 加入查询扩展、候选池放大、融合后的 soft diversification
- Modify: `src/rag/retrieval/reranker.ts`
  - 增加轻量文档衰减工具函数，保留现有 `rrfFuse` 和 `mmrRerank`
- Modify: `src/rag/injection/index.ts`
  - 注入时展示父路径和父级上下文，避免只看到孤立子块
- Modify: `src/tests/unit/rag-chunking.test.ts`
  - 增加父子块与父上下文的失败用例
- Modify: `src/tests/unit/rag-retrieval.test.ts`
  - 增加查询扩展、候选池和 soft diversification 的失败用例

### Task 1: 定义父子块与检索选项

**Files:**
- Modify: `src/rag/types.ts`
- Modify: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 写失败用例，锁定父子块元数据**

```ts
it("为子块保留父路径与父上下文", () => {
  const text = [
    "# 总览",
    "系统负责统一调度任务。",
    "",
    "## 检索流程",
    "先扩展查询，再融合排序，最后注入上下文。",
    "",
    "- 扩展查询",
    "- 候选融合",
  ].join("\n");

  const result = chunkText(text, "plan.md", {
    chunkSize: 120,
    minChunkSize: 20,
    parentContextChars: 120,
  });

  const retrievalChunk = result.find((item) => item.metadata.sectionTitle === "检索流程");
  expect(retrievalChunk?.metadata.parentPath).toEqual(["总览", "检索流程"]);
  expect(retrievalChunk?.metadata.parentContext).toContain("先扩展查询");
  expect(typeof retrievalChunk?.metadata.childIndexInParent).toBe("number");
});
```

- [ ] **Step 2: 写失败用例，锁定标题不会直接成为叶子检索块**

```ts
it("标题只用于构造父块上下文，不直接输出为孤立叶子块", () => {
  const text = ["# 第一章", "正文A", "", "## 第二节", "正文B"].join("\n");
  const result = chunkText(text, "doc.md", { chunkSize: 120, minChunkSize: 10 });
  expect(result.some((item) => item.content === "# 第一章")).toBe(false);
  expect(result.every((item) => item.metadata.parentPath?.length)).toBeTruthy();
});
```

- [ ] **Step 3: 扩展类型定义**

```ts
export type ChunkMeta = {
  docFileName: string;
  sectionTitle?: string;
  chunkIndex: number;
  lineRange?: [number, number];
  tokenCount: number;
  blockType?: ChunkBlockType;
  path?: string[];
  startOffset?: number;
  endOffset?: number;
  parentPath?: string[];
  parentContext?: string;
  childIndexInParent?: number;
};

export type ChunkOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
  parentContextChars?: number;
};

export type RetrieveOptions = {
  topK?: number;
  minScore?: number;
  candidatePoolMultiplier?: number;
  candidatePoolMin?: number;
  queryRewriteLimit?: number;
};
```

- [ ] **Step 4: 跑分块单测，确认新用例先失败**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: FAIL，提示缺少 `parentPath` / `parentContext` / `childIndexInParent`

### Task 2: 实现父子块分块

**Files:**
- Modify: `src/rag/chunking/index.ts`
- Test: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 增加父章节块类型**

```ts
type ParentChunk = {
  sectionTitle?: string;
  parentPath: string[];
  parentContext: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  blocks: ParsedBlock[];
};
```

- [ ] **Step 2: 从结构块构建父章节块**

```ts
function buildParentChunks(blocks: ParsedBlock[], parentContextChars: number): ParentChunk[] {
  const grouped = new Map<string, ParsedBlock[]>();
  for (const block of blocks) {
    const key = block.path.join("\u0000") || "__root__";
    const row = grouped.get(key) ?? [];
    row.push(block);
    grouped.set(key, row);
  }

  return [...grouped.values()].map((group) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const parentContext = group
      .map((item) => item.content)
      .join("\n\n")
      .slice(0, parentContextChars);

    return {
      sectionTitle: first.sectionTitle,
      parentPath: first.path,
      parentContext,
      startLine: first.startLine,
      endLine: last.endLine,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      blocks: group,
    };
  });
}
```

- [ ] **Step 3: 在父章节块内生成子检索块**

```ts
function buildChildChunks(
  parents: ParentChunk[],
  chunkSize: number,
  chunkOverlap: number,
  minChunkSize: number,
): ParsedBlock[] {
  return parents.flatMap((parent) => {
    const merged = mergeSmallBlocks(parent.blocks, minChunkSize);
    const split = splitOversizeBlocks(merged, chunkSize, chunkOverlap);

    return split.map((block, childIndexInParent) => ({
      ...block,
      path: [...parent.parentPath],
      sectionTitle: parent.sectionTitle,
      parentPath: [...parent.parentPath],
      parentContext: parent.parentContext,
      childIndexInParent,
    }));
  });
}
```

- [ ] **Step 4: 定义最终内部块类型，避免随手拼对象**

```ts
type FinalChunkBlock = ParsedBlock & {
  parentPath: string[];
  parentContext: string;
  childIndexInParent: number;
};
```

- [ ] **Step 5: 更新 `chunkText()` 输出**

```ts
const parsed = parseBlocks(normalized);
const parents = buildParentChunks(parsed, options?.parentContextChars ?? 240);
const finalBlocks = buildChildChunks(parents, chunkSize, chunkOverlap, minChunkSize);

return finalBlocks.map((block, chunkIndex) => ({
  content: block.content,
  metadata: {
    docFileName,
    chunkIndex,
    lineRange: [block.startLine, block.endLine],
    tokenCount: estimateTokens(block.content),
    ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
    ...(block.blockType ? { blockType: block.blockType } : {}),
    ...(block.path.length > 0 ? { path: block.path } : {}),
    ...(block.parentPath.length > 0 ? { parentPath: block.parentPath } : {}),
    ...(block.parentContext ? { parentContext: block.parentContext } : {}),
    { childIndexInParent: block.childIndexInParent },
    ...(block.startOffset !== undefined ? { startOffset: block.startOffset } : {}),
    ...(block.endOffset !== undefined ? { endOffset: block.endOffset } : {}),
  },
}));
```

- [ ] **Step 6: 跑分块单测，确认通过**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: PASS

### Task 3: 锁定查询扩展、候选池与 soft diversification

**Files:**
- Modify: `src/tests/unit/rag-retrieval.test.ts`

- [ ] **Step 1: 写失败用例，锁定 query rewrite**

```ts
it("为中英文混合术语生成有限查询扩展", () => {
  const rewrites = expandQueries("Quest worktree 并行开发", 3);
  expect(rewrites[0]).toBe("Quest worktree 并行开发");
  expect(rewrites.length).toBeLessThanOrEqual(3);
  expect(rewrites.some((item) => item.includes("worktree"))).toBe(true);
  expect(new Set(rewrites).size).toBe(rewrites.length);
});
```

- [ ] **Step 2: 写失败用例，锁定候选池规模**

```ts
it("按固定下限和倍率放大候选池", () => {
  expect(resolveCandidatePoolSize(5, undefined, undefined)).toBe(40);
  expect(resolveCandidatePoolSize(2, undefined, undefined)).toBe(20);
  expect(resolveCandidatePoolSize(4, 6, 30)).toBe(30);
});
```

- [ ] **Step 3: 写失败用例，锁定 soft diversification**

```ts
it("对同文档连续命中做轻量衰减而不是硬裁剪", () => {
  const results: RetrievalResult[] = [
    { chunk: makeChunk("a", "A", "doc-1"), score: 0.95, source: "doc-1" },
    { chunk: makeChunk("b", "B", "doc-1"), score: 0.94, source: "doc-1" },
    { chunk: makeChunk("c", "C", "doc-2"), score: 0.90, source: "doc-2" },
  ];

  const diversified = applySoftDiversification(results, 0.92);
  expect(diversified).toHaveLength(3);
  expect(diversified[0]?.chunk.id).toBe("a");
  expect(diversified.some((item) => item.chunk.id === "c")).toBe(true);
  expect((diversified.find((item) => item.chunk.id === "b")?.score ?? 0)).toBeLessThan(0.94);
});
```

- [ ] **Step 4: 先跑检索单测，确认失败**

Run: `npm test -- src/tests/unit/rag-retrieval.test.ts`

Expected: FAIL，提示 `expandQueries` / `resolveCandidatePoolSize` / `applySoftDiversification` 未定义

### Task 4: 实现检索链路优化

**Files:**
- Modify: `src/rag/retrieval/index.ts`
- Modify: `src/rag/retrieval/reranker.ts`
- Modify: `src/tests/unit/rag-retrieval.test.ts`

- [ ] **Step 1: 在检索模块中加入候选池计算**

```ts
const DEFAULT_CANDIDATE_POOL_MULTIPLIER = 8;
const DEFAULT_CANDIDATE_POOL_MIN = 20;
const DEFAULT_QUERY_REWRITE_LIMIT = 3;

export function resolveCandidatePoolSize(
  topK: number,
  candidatePoolMultiplier: number = DEFAULT_CANDIDATE_POOL_MULTIPLIER,
  candidatePoolMin: number = DEFAULT_CANDIDATE_POOL_MIN,
): number {
  return Math.max(candidatePoolMin, topK * candidatePoolMultiplier);
}
```

- [ ] **Step 2: 增加轻量 query rewrite**

```ts
export function expandQueries(query: string, limit: number = DEFAULT_QUERY_REWRITE_LIMIT): string[] {
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }

  const variants = [
    normalized,
    tokenize(normalized).join(" "),
    normalized.replace(/\s+/g, " "),
    normalized.replace(/[，。、“”"'`]/g, " "),
  ];

  return [...new Set(variants.map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}
```

- [ ] **Step 3: 在 `reranker.ts` 中加入 soft diversification**

```ts
export function applySoftDiversification(
  results: RetrievalResult[],
  decay: number = 0.92,
): RetrievalResult[] {
  const counts = new Map<string, number>();
  return [...results]
    .map((item) => {
      const seen = counts.get(item.chunk.docId) ?? 0;
      counts.set(item.chunk.docId, seen + 1);
      return {
        ...item,
        score: item.score * Math.pow(decay, seen),
      };
    })
    .sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: 用多查询并行召回替换单查询召回**

```ts
const candidatePoolSize = resolveCandidatePoolSize(
  topK,
  options?.candidatePoolMultiplier,
  options?.candidatePoolMin,
);
const expandedQueries = expandQueries(query, options?.queryRewriteLimit);

const semanticResults = (
  await Promise.all(
    expandedQueries.map((variant) =>
      useStoredSemantic
        ? store.search((await embedChunks([{ id: "__query__", content: variant }], apiConfig)).get("__query__") ?? [], candidatePoolSize)
        : localSemanticSearch(variant, allChunks, candidatePoolSize),
    ),
  )
).flat();

const keywordResults = expandedQueries.flatMap((variant) =>
  keywordSearch(
    variant,
    allChunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
    candidatePoolSize,
  ),
);
```

- [ ] **Step 5: 合并去重后再做 RRF、MMR 和 soft diversification**

```ts
const fused = rrfFuse(dedupeByChunkId(semanticResults), mapKeywordRows(keywordResults, chunkMap))
  .filter((item) => item.score >= minScore)
  .slice(0, candidatePoolSize);

const reranked = mmrRerank(fused, candidatePoolSize, 0.3);
const diversified = applySoftDiversification(reranked);
return takeTopResults(diversified, topK);
```

- [ ] **Step 6: 跑检索单测，确认通过**

Run: `npm test -- src/tests/unit/rag-retrieval.test.ts`

Expected: PASS

### Task 5: 更新注入阶段并做回归验证

**Files:**
- Modify: `src/rag/injection/index.ts`
- Modify: `src/tests/unit/rag-retrieval.test.ts`
- Modify: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 注入时显示父路径和父级上下文**

```ts
const parentPath = result.chunk.metadata.parentPath?.join(" > ");
const parentContext = result.chunk.metadata.parentContext?.trim();
const prefix = parentPath ? `章节：${parentPath}\n` : "";
const context = parentContext ? `父级上下文：${parentContext}\n\n` : "";
const citation = `### 引用 ${i + 1}（来源：${result.source}，相关度：${result.score.toFixed(2)}）\n${prefix}${context}${quote}\n\n`;
```

- [ ] **Step 2: 跑两个目标单测**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts src/tests/unit/rag-retrieval.test.ts`

Expected: PASS

- [ ] **Step 3: 跑类型检查**

Run: `npx tsc --noEmit --pretty false`

Expected: 无输出

- [ ] **Step 4: 手动重建测试知识库并验证**

Run: 通过现有知识库上传入口删除并重新导入测试文档

Expected:
- `worktree` 查询前 5 条不再被单文档相邻块完全占满
- `Quest worktree` 查询可看到 query rewrite 带来的多术语命中
- 注入文本包含 `章节` 和 `父级上下文`

- [ ] **Step 5: 提交**

```bash
git add src/rag/types.ts src/rag/chunking/index.ts src/rag/retrieval/index.ts src/rag/retrieval/reranker.ts src/rag/injection/index.ts src/tests/unit/rag-chunking.test.ts src/tests/unit/rag-retrieval.test.ts
git commit -m "feat: improve rag chunking and retrieval quality"
```
