# RAG Chunking Hybrid Parent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前“完整路径精确分组”的父块改成“结构化文档按章节子树聚合、非结构化文档按连续块簇聚合”的混合父块策略。

**Architecture:** 保留 `parseBlocks()`、小块合并和超长块切分，让检索子块继续保持细粒度；仅替换父块构建层，为每个原始块计算章节型或簇型父块，并把 `parentPath`、`parentContext`、`parentKind`、`parentTitle` 回填到子块元数据中。前端只做轻量展示增强，不改检索与注入主流程。

**Tech Stack:** TypeScript, Node.js, Vitest

---

## File Map

- Modify: `src/rag/types.ts`
  - 扩展父块元数据类型
- Modify: `src/rag/chunking/index.ts`
  - 实现章节父块和簇父块混合聚合
- Modify: `src/tests/unit/rag-chunking.test.ts`
  - 增加章节子树聚合和无结构簇聚合失败用例
- Modify: `public/js/ragModal.js`
  - 展示 `parentKind` 与 `parentTitle`

### Task 1: 扩展分块元数据类型

**Files:**
- Modify: `src/rag/types.ts`
- Test: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 写失败用例，锁定章节父块会标记 `section`**

```ts
it("结构化文档的子块会继承章节父块元数据", () => {
  const text = [
    "# 手册",
    "",
    "## Day 0",
    "",
    "### 不写代码，只写 Spec",
    "导语。",
    "",
    "### 步骤 1：定义 MVP 边界",
    "步骤说明。",
    "",
    "#### 产出物",
    "范围文档。",
  ].join("\n");

  const result = chunkText(text, "guide.md", { chunkSize: 120, minChunkSize: 10, parentContextChars: 200 });
  const target = result.find((item) => item.content.includes("范围文档"));

  expect(target?.metadata.parentKind).toBe("section");
  expect(target?.metadata.parentTitle).toBe("步骤 1：定义 MVP 边界");
});
```

- [ ] **Step 2: 写失败用例，锁定无结构文本会标记 `cluster`**

```ts
it("无结构长文会退化为连续父簇", () => {
  const text = [
    "第一段：背景说明。",
    "",
    "第二段：问题分析与现状。",
    "",
    "第三段：方案比较。",
    "",
    "第四段：实施建议。",
  ].join("\n");

  const result = chunkText(text, "essay.md", {
    chunkSize: 80,
    minChunkSize: 10,
    parentContextChars: 240,
  });

  expect(result.every((item) => item.metadata.parentKind === "cluster")).toBe(true);
  expect(result.every((item) => typeof item.metadata.parentTitle === "string")).toBe(true);
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
  parentKind?: "section" | "cluster";
  parentTitle?: string;
  childIndexInParent?: number;
};
```

- [ ] **Step 4: 跑分块单测，确认先失败**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: FAIL，提示缺少 `parentKind` / `parentTitle`

### Task 2: 实现结构化文档章节父块

**Files:**
- Modify: `src/rag/chunking/index.ts`
- Test: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 定义内部父块类型**

```ts
type ParentChunkKind = "section" | "cluster";

type ParentChunk = {
  sectionTitle?: string;
  parentPath: string[];
  parentContext: string;
  parentKind: ParentChunkKind;
  parentTitle: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  blocks: ParsedBlock[];
};
```

- [ ] **Step 2: 新增章节统计与父路径解析工具**

```ts
function countHeadingPaths(blocks: ParsedBlock[]): number {
  return new Set(blocks.map((block) => block.path.join("\u0000")).filter(Boolean)).size;
}

function resolveSectionParentPath(path: string[]): string[] {
  if (path.length <= 1) {
    return [...path];
  }
  return path.slice(0, -1);
}

function buildSectionTitle(path: string[]): string {
  return path[path.length - 1] || "未命名章节";
}
```

- [ ] **Step 3: 用章节子树替换精确路径分组**

```ts
function buildSectionParentChunks(blocks: ParsedBlock[], parentContextChars: number): ParentChunk[] {
  const grouped = new Map<string, ParsedBlock[]>();

  for (const block of blocks) {
    const parentPath = resolveSectionParentPath(block.path);
    const key = parentPath.join("\u0000") || "__root__";
    const row = grouped.get(key) ?? [];
    row.push(block);
    grouped.set(key, row);
  }

  return [...grouped.entries()].map(([key, group]) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const parentPath = key === "__root__" ? [] : key.split("\u0000");
    return {
      parentPath,
      parentContext: group.map((item) => item.content).join("\n\n").slice(0, parentContextChars),
      parentKind: "section",
      parentTitle: buildSectionTitle(parentPath.length > 0 ? parentPath : first.path),
      startLine: first.startLine,
      endLine: last.endLine,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      blocks: group,
      ...(parentPath.length > 0 ? { sectionTitle: parentPath[parentPath.length - 1] } : {}),
    };
  });
}
```

- [ ] **Step 4: 写失败用例，锁定同一章节下子标题共享父块**

```ts
it("同一章节下的多个子标题共享最近上级章节父块", () => {
  const text = [
    "# 手册",
    "总览。",
    "",
    "## 步骤 1：定义 MVP 边界",
    "步骤说明。",
    "",
    "### 要做什么？",
    "写一句核心价值主张。",
    "",
    "### 产出物",
    "范围文档。",
  ].join("\n");

  const result = chunkText(text, "guide.md", { chunkSize: 120, minChunkSize: 10, parentContextChars: 240 });
  const a = result.find((item) => item.content.includes("核心价值主张"));
  const b = result.find((item) => item.content.includes("范围文档"));

  expect(a?.metadata.parentPath).toEqual(["手册", "步骤 1：定义 MVP 边界"]);
  expect(b?.metadata.parentPath).toEqual(["手册", "步骤 1：定义 MVP 边界"]);
  expect(b?.metadata.parentContext).toContain("步骤说明");
  expect(b?.metadata.parentContext).toContain("核心价值主张");
});
```

- [ ] **Step 5: 跑分块单测，确认章节父块通过**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: 前面新增的章节父块用例 PASS；无结构簇用例仍可能 FAIL

### Task 3: 实现无结构文本簇父块

**Files:**
- Modify: `src/rag/chunking/index.ts`
- Test: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 增加簇模式常量**

```ts
const DEFAULT_PARENT_CONTEXT_CHARS = 240;
const CLUSTER_TARGET_CHARS = 900;
const CLUSTER_MAX_CHARS = 1400;
const MIN_HEADING_PATHS_FOR_SECTIONS = 3;
```

- [ ] **Step 2: 实现簇父块构建**

```ts
function buildClusterParentChunks(blocks: ParsedBlock[], parentContextChars: number): ParentChunk[] {
  const parents: ParentChunk[] = [];
  let bucket: ParsedBlock[] = [];
  let bucketChars = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    parents.push({
      parentPath: first.path.length > 0 ? [first.path[0]!] : [],
      parentContext: bucket.map((item) => item.content).join("\n\n").slice(0, parentContextChars),
      parentKind: "cluster",
      parentTitle: `未命名片段 ${parents.length + 1}`,
      startLine: first.startLine,
      endLine: last.endLine,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      blocks: bucket,
      ...(first.sectionTitle ? { sectionTitle: first.sectionTitle } : {}),
    });
    bucket = [];
    bucketChars = 0;
  };

  for (const block of blocks) {
    const nextChars = bucketChars + block.content.length;
    if (bucket.length > 0 && nextChars > CLUSTER_MAX_CHARS && bucketChars >= CLUSTER_TARGET_CHARS) {
      flush();
    }
    bucket.push(block);
    bucketChars += block.content.length;
  }
  flush();
  return parents;
}
```

- [ ] **Step 3: 用混合选择器决定父块模式**

```ts
function buildParentChunks(blocks: ParsedBlock[], parentContextChars: number): ParentChunk[] {
  const headingPathCount = countHeadingPaths(blocks);
  if (headingPathCount >= MIN_HEADING_PATHS_FOR_SECTIONS) {
    return buildSectionParentChunks(blocks, parentContextChars);
  }
  return buildClusterParentChunks(blocks, parentContextChars);
}
```

- [ ] **Step 4: 写失败用例，锁定无标题长文会产生多个父簇**

```ts
it("无标题长文不会退化成单个空父块", () => {
  const text = [
    "第一段".repeat(120),
    "",
    "第二段".repeat(120),
    "",
    "第三段".repeat(120),
    "",
    "第四段".repeat(120),
  ].join("\n");

  const result = chunkText(text, "essay.md", {
    chunkSize: 120,
    chunkOverlap: 20,
    minChunkSize: 10,
    parentContextChars: 320,
  });

  const titles = new Set(result.map((item) => item.metadata.parentTitle));
  expect(titles.size).toBeGreaterThan(1);
  expect(result.every((item) => item.metadata.parentKind === "cluster")).toBe(true);
});
```

- [ ] **Step 5: 跑分块单测，确认通过**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: PASS

### Task 4: 回填新元数据并增强前端展示

**Files:**
- Modify: `src/rag/chunking/index.ts`
- Modify: `public/js/ragModal.js`

- [ ] **Step 1: 把新父块字段回填到最终子块**

```ts
type FinalChunkBlock = ParsedBlock & {
  parentPath: string[];
  parentContext: string;
  parentKind: ParentChunkKind;
  parentTitle: string;
  childIndexInParent: number;
};
```

```ts
return split.map((block, childIndexInParent) => ({
  ...block,
  parentPath: [...parent.parentPath],
  parentContext: parent.parentContext,
  parentKind: parent.parentKind,
  parentTitle: parent.parentTitle,
  childIndexInParent,
  ...(parent.sectionTitle ? { sectionTitle: parent.sectionTitle } : {}),
}));
```

- [ ] **Step 2: 输出最终 metadata**

```ts
const metadata: ChunkMeta = {
  docFileName,
  chunkIndex,
  lineRange: [block.startLine, block.endLine],
  tokenCount: estimateTokens(block.content),
  ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
  ...(block.blockType ? { blockType: block.blockType } : {}),
  ...(block.path.length > 0 ? { path: block.path } : {}),
  ...(block.parentPath.length > 0 ? { parentPath: block.parentPath } : {}),
  ...(block.parentContext ? { parentContext: block.parentContext } : {}),
  parentKind: block.parentKind,
  parentTitle: block.parentTitle,
  childIndexInParent: block.childIndexInParent,
  ...(block.startOffset !== undefined ? { startOffset: block.startOffset } : {}),
  ...(block.endOffset !== undefined ? { endOffset: block.endOffset } : {}),
};
```

- [ ] **Step 3: 在分块弹窗中展示父块类型与标题**

```js
const parentKindLabel = result?.chunk?.metadata?.parentKind === "cluster" ? "连续片段" : "章节父块";
const parentTitle = String(result?.chunk?.metadata?.parentTitle || "").trim();
```

```js
${parentTitle ? `<div style="margin-top:4px;"><strong>父块标题：</strong>${escapeHtml(parentTitle)}</div>` : ""}
<div style="margin-top:4px;"><strong>父块类型：</strong>${escapeHtml(parentKindLabel)}</div>
```

- [ ] **Step 4: 跑分块相关 UI 单测**

Run: `npm test -- src/tests/unit/rag-ui.test.ts`

Expected: PASS

### Task 5: 完整验证并提交

**Files:**
- Modify: `src/rag/types.ts`
- Modify: `src/rag/chunking/index.ts`
- Modify: `src/tests/unit/rag-chunking.test.ts`
- Modify: `public/js/ragModal.js`

- [ ] **Step 1: 跑目标测试**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts src/tests/unit/rag-ui.test.ts`

Expected: PASS

- [ ] **Step 2: 跑全量测试**

Run: `npm test`

Expected: PASS

- [ ] **Step 3: 跑类型检查**

Run: `npx tsc --noEmit --pretty false`

Expected: 无输出

- [ ] **Step 4: 提交**

```bash
git add src/rag/types.ts src/rag/chunking/index.ts src/tests/unit/rag-chunking.test.ts public/js/ragModal.js docs/superpowers/specs/2026-05-15-rag-chunking-hybrid-parent-design.md docs/superpowers/plans/2026-05-15-rag-chunking-hybrid-parent-implementation.md
git commit -m "feat(rag): improve hybrid parent chunking"
```
