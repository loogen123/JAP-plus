# RAG Chunking Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 RAG 增加结构化分块，并把检索结果改成按全局相关度排序而不是按文件限额截断。

**Architecture:** 先扩展 `ChunkMeta`，让分块阶段显式识别标题、列表、代码块、表格、引用和普通段落，再通过小块合并和超长块滑窗生成最终分块。检索阶段保留现有语义召回、关键词召回、RRF 融合和 MMR 重排，只删除按文档配额过滤的逻辑，最终直接截取全局 `topK`。

**Tech Stack:** TypeScript, Node.js, Vitest

---

### Task 1: 扩展分块元数据与测试

**Files:**
- Modify: `src/rag/types.ts`
- Modify: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 写失败用例，覆盖结构化分块元数据**

```ts
it("为结构化分块补充元数据", () => {
  const text = [
    "# 用户管理",
    "",
    "- 创建用户",
    "- 删除用户",
    "",
    "```ts",
    "const enabled = true;",
    "```",
  ].join("\n");

  const result = chunkText(text, "spec.md", { chunkSize: 500, minChunkSize: 20 });
  expect(result.length).toBeGreaterThanOrEqual(2);
  expect(result.some((item) => item.metadata.blockType === "list")).toBe(true);
  expect(result.some((item) => item.metadata.blockType === "code")).toBe(true);
  expect(result.every((item) => item.metadata.sectionTitle === "用户管理")).toBe(true);
  expect(result.every((item) => Array.isArray(item.metadata.path))).toBe(true);
});
```

- [ ] **Step 2: 写失败用例，覆盖“小块不跨章节合并”**

```ts
it("不会跨章节合并极短分块", () => {
  const text = ["# 第一章", "短", "", "# 第二章", "另一个短段落"].join("\n");
  const result = chunkText(text, "split.md", { chunkSize: 500, minChunkSize: 50 });
  expect(result).toHaveLength(2);
  expect(result[0]?.metadata.sectionTitle).toBe("第一章");
  expect(result[1]?.metadata.sectionTitle).toBe("第二章");
});
```

- [ ] **Step 3: 扩展 `ChunkMeta` 类型**

```ts
export type ChunkBlockType = "paragraph" | "list" | "table" | "code" | "quote";

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
};
```

- [ ] **Step 4: 运行分块单测，确认先失败再修复**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: 新增用例失败，提示缺少 `blockType` / `path` 或当前分块结果数量不符合预期

### Task 2: 重写结构化分块实现

**Files:**
- Modify: `src/rag/chunking/index.ts`
- Test: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 增加结构块内部类型和扫描逻辑**

```ts
type ParsedBlock = {
  content: string;
  blockType: ChunkBlockType;
  sectionTitle?: string;
  path: string[];
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
};
```

```ts
function parseBlocks(text: string): ParsedBlock[] {
  // 逐行扫描，维护标题层级栈
  // 识别 fenced code、heading、list、table、quote、paragraph
  // heading 只更新上下文，不直接生成最终 chunk
}
```

- [ ] **Step 2: 增加小块合并逻辑**

```ts
function canMergeBlocks(previous: ParsedBlock, current: ParsedBlock): boolean {
  return (
    previous.path.join(" / ") === current.path.join(" / ") &&
    previous.blockType === current.blockType &&
    previous.blockType !== "code"
  );
}
```

```ts
function mergeSmallBlocks(blocks: ParsedBlock[], minChunkSize: number): ParsedBlock[] {
  // 仅在同 path、同类型、非 code 的情况下合并
}
```

- [ ] **Step 3: 增加超长块滑窗切分**

```ts
function splitOversizeBlocks(blocks: ParsedBlock[], chunkSize: number, chunkOverlap: number): ParsedBlock[] {
  // 仅处理 paragraph 和 code
  // 子块继承 sectionTitle、path、blockType、范围信息
}
```

- [ ] **Step 4: 更新 `chunkText()` 组装最终结果**

```ts
return finalBlocks.map((block, chunkIndex) => ({
  content: block.content,
  metadata: {
    docFileName,
    sectionTitle: block.sectionTitle,
    chunkIndex,
    lineRange: [block.startLine, block.endLine],
    tokenCount: estimateTokens(block.content),
    blockType: block.blockType,
    path: block.path,
    startOffset: block.startOffset,
    endOffset: block.endOffset,
  },
}));
```

- [ ] **Step 5: 运行分块单测，确认通过**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: PASS

### Task 3: 用测试锁定全局排序检索

**Files:**
- Modify: `src/tests/unit/rag-retrieval.test.ts`

- [ ] **Step 1: 提取最终结果裁剪逻辑为可测试函数的预期**

```ts
it("允许同一文档返回多个高分块", () => {
  const results: RetrievalResult[] = [
    { chunk: makeChunk("a", "登录设计", "doc-1"), score: 0.95, source: "" },
    { chunk: makeChunk("b", "登录接口", "doc-1"), score: 0.90, source: "" },
    { chunk: makeChunk("c", "系统设置", "doc-2"), score: 0.60, source: "" },
  ];

  const ranked = takeTopResults(results, 2);
  expect(ranked.map((item) => item.chunk.id)).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: 写失败用例，覆盖“按全局顺序截断 topK”**

```ts
it("按全局分数顺序截断 topK", () => {
  const results: RetrievalResult[] = [
    { chunk: makeChunk("a", "A", "doc-1"), score: 0.81, source: "" },
    { chunk: makeChunk("b", "B", "doc-2"), score: 0.79, source: "" },
    { chunk: makeChunk("c", "C", "doc-1"), score: 0.78, source: "" },
  ];

  const ranked = takeTopResults(results, 2);
  expect(ranked.map((item) => item.chunk.id)).toEqual(["a", "b"]);
});
```

- [ ] **Step 3: 先运行检索单测**

Run: `npm test -- src/tests/unit/rag-retrieval.test.ts`

Expected: FAIL，提示 `takeTopResults` 未定义

### Task 4: 删除文档配额限制

**Files:**
- Modify: `src/rag/retrieval/index.ts`
- Modify: `src/tests/unit/rag-retrieval.test.ts`

- [ ] **Step 1: 调整测试辅助函数，支持传入 docId**

```ts
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
```

- [ ] **Step 2: 在检索模块中提取最终裁剪函数**

```ts
export function takeTopResults(results: RetrievalResult[], topK: number): RetrievalResult[] {
  return results.slice(0, topK);
}
```

- [ ] **Step 3: 删除按文档配额过滤逻辑**

```ts
const fused = rrfFuse(semanticResults, keywordResults)
  .filter((item) => item.score >= minScore)
  .slice(0, topK * 2);

const reranked = mmrRerank(fused, topK * 3, 0.3);
return takeTopResults(reranked, topK);
```

- [ ] **Step 4: 运行检索单测**

Run: `npm test -- src/tests/unit/rag-retrieval.test.ts`

Expected: PASS

### Task 5: 回归验证

**Files:**
- Modify: `src/tests/unit/rag-chunking.test.ts`
- Modify: `src/tests/unit/rag-retrieval.test.ts`
- Check: `src/rag/chunking/index.ts`
- Check: `src/rag/retrieval/index.ts`
- Check: `src/rag/types.ts`

- [ ] **Step 1: 跑两个目标单测**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts src/tests/unit/rag-retrieval.test.ts`

Expected: PASS

- [ ] **Step 2: 查诊断**

Run: 使用编辑器诊断检查 `src/rag/chunking/index.ts`、`src/rag/retrieval/index.ts`、`src/rag/types.ts`

Expected: 无新增类型错误

- [ ] **Step 3: 手动核对验收点**

```txt
1. 分块可识别 list / code 等结构
2. 小块不跨 section 合并
3. 检索允许单文档多块同时返回
4. topK 按全局顺序截断
```
