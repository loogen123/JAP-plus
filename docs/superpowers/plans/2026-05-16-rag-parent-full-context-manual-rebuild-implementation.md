# RAG Parent Full Context Manual Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 不做旧知识库自动迁移，保留现有 `parentFullContext` 生成与展示链路，由用户手动重建知识库后恢复完整父模块显示。

**Architecture:** 不新增 `backfill` 模块，不在查询前补算旧索引，也不写回历史 `chunks-index.json`。后端继续在新分块时产出 `parentContext` 与 `parentFullContext`，前端继续优先显示 `parentFullContext`；执行阶段只做回归验证与手动重建后的验收。

**Tech Stack:** TypeScript, Node.js, Vitest, Browser UI

---

## File Map

- Verify: `src/rag/types.ts`
  - 确认 `ChunkMeta` 已保留 `parentPath`、`parentContext`、`parentFullContext`、`parentKind`、`parentTitle`
- Verify: `src/rag/chunking/index.ts`
  - 确认新分块持续产出完整父模块正文与短预览
- Verify: `public/js/ragModal.js`
  - 确认弹窗继续优先读取 `parentFullContext`，并保留父/子模块 7:3 独立滚动布局
- Verify: `src/tests/unit/rag-chunking.test.ts`
  - 确认已有单测覆盖完整父模块字段
- Verify: `src/tests/unit/rag-ui.test.ts`
  - 确认已有单测覆盖弹窗显示完整父模块内容
- Do Not Create: `src/rag/backfill/index.ts`
- Do Not Modify: `src/rag/index.ts`
- Do Not Modify: `src/rag/kbManager.ts`

## Non-Goals

- 不做旧知识库索引自动升级
- 不做查询前一次性迁移
- 不做运行时父模块补算
- 不做旧索引写回 marker

### Task 1: 验证后端分块元数据链路

**Files:**
- Verify: `src/rag/types.ts`
- Verify: `src/rag/chunking/index.ts`
- Test: `src/tests/unit/rag-chunking.test.ts`

- [ ] **Step 1: 保持 `ChunkMeta` 完整父模块字段契约**

```ts
export type ChunkMeta = {
  parentPath?: string[];
  parentContext?: string;
  parentFullContext?: string;
  parentKind?: "section" | "cluster";
  parentTitle?: string;
  childIndexInParent?: number;
};
```

- [ ] **Step 2: 保持分块阶段同时产出短预览和完整父模块正文**

```ts
type ParentChunk = {
  parentPath: string[];
  parentContext: string;
  parentFullContext: string;
  parentKind: ParentChunkKind;
  parentTitle: string;
  blocks: ParsedBlock[];
};
```

- [ ] **Step 3: 跑分块回归测试**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts`

Expected: PASS，且包含 `parentFullContext` 同时命中当前子块内容与同父模块上下文的断言

### Task 2: 验证前端完整父模块展示链路

**Files:**
- Verify: `public/js/ragModal.js`
- Test: `src/tests/unit/rag-ui.test.ts`

- [ ] **Step 1: 保持弹窗优先读取 `parentFullContext` 的回退顺序**

```js
const parentContext = String(
  result?.chunk?.metadata?.parentFullContext
  || result?.chunk?.metadata?.parentContext
  || "",
).trim();
```

- [ ] **Step 2: 保持父模块大于子模块的 7:3 独立滚动布局**

```js
<div class="modal-bd" style="padding:12px;display:grid;grid-template-rows:auto minmax(0,7fr) minmax(0,3fr);gap:10px;min-height:0;overflow:hidden;">
```

- [ ] **Step 3: 跑弹窗回归测试**

Run: `npm test -- src/tests/unit/rag-ui.test.ts`

Expected: PASS，且包含“父模块完整内容”和“命中子模块”分栏断言

### Task 3: 手动重建知识库后的验收

**Files:**
- Verify: `src/tests/unit/rag-chunking.test.ts`
- Verify: `src/tests/unit/rag-ui.test.ts`

- [ ] **Step 1: 跑聚合回归**

Run: `npm test -- src/tests/unit/rag-chunking.test.ts src/tests/unit/rag-ui.test.ts`

Expected: PASS

- [ ] **Step 2: 跑类型检查**

Run: `npx tsc --noEmit --pretty false`

Expected: 无输出

- [ ] **Step 3: 手动重建旧知识库**

```text
1. 删除旧知识库
2. 重新创建知识库
3. 重新上传原始文档
4. 等待新索引构建完成
5. 对同一问题重新发起检索
```

- [ ] **Step 4: 验收完整父模块显示**

Run: 在知识库页面点击检索结果，打开分块预览弹窗

Expected:
- 父模块区域显示完整父模块正文
- 当前命中的子模块文本能在父模块正文中找到
- 子模块区域仍只显示命中 chunk
- 查询链路没有任何旧索引迁移或补算等待

- [ ] **Step 5: 提交计划文档**

```bash
git add docs/superpowers/plans/2026-05-16-rag-parent-full-context-manual-rebuild-implementation.md
git commit -m "docs(plan): rewrite rag parent context plan for manual rebuild"
```
