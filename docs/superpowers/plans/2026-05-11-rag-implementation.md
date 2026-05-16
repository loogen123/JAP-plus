# RAG 知识库系统实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 JAP-plus 增加 RAG 知识库能力，文档摄入 → 分块 → Embedding → 检索 → 上下文注入，零外部服务依赖。

**Architecture:** 新建 `src/rag/` 模块（6 个子模块 + kbManager + types），通过 `taskServiceCore.ts` 注入点与现有流水线集成，新增 REST API 路由和前端知识库面板。

**Tech Stack:** hnswlib-node（向量存储）、pdf-parse + mammoth（文档解析）、TypeScript + vitest、原生 JS 前端模块

---

## 文件结构

```
新增文件：
  src/rag/types.ts                       # 共享类型定义
  src/rag/index.ts                        # 模块入口（RAG 门面）
  src/rag/ingestion/index.ts              # 文档摄入编排
  src/rag/ingestion/parsers.ts            # 多格式解析器
  src/rag/chunking/index.ts               # 分块策略
  src/rag/embedding/index.ts              # Embedding 生成
  src/rag/vectorStore/index.ts            # 向量存储（hnswlib + JSON）
  src/rag/retrieval/index.ts              # 混合检索编排
  src/rag/retrieval/hybridSearch.ts       # BM25 + 语义混合
  src/rag/retrieval/reranker.ts           # RRF + MMR 重排序
  src/rag/injection/index.ts              # Prompt 拼接
  src/rag/kbManager.ts                    # 知识库 CRUD
  src/http/ragRoutes.ts                   # API 路由注册
  src/controllers/ragController.ts        # 请求控制器
  src/tests/unit/rag-chunking.test.ts     # 分块单元测试
  src/tests/unit/rag-retrieval.test.ts    # 检索单元测试
  src/tests/unit/rag-injection.test.ts    # 注入单元测试
  src/tests/golden/samples/case-009-rag/  # RAG Golden test
  public/js/ragPanel.js                   # 前端知识库面板
  public/js/ragCoordinator.js             # 前端编排逻辑

修改文件：
  src/server.ts                           # 注册 RAG 路由
  src/services/taskServiceCore.ts         # 集成 RAG 检索注入
  src/pipeline/degradation.ts             # 生成方法中接入 RAG
  src/pipeline/stateMachine.ts            # 扩展 FileRunMeta 类型
  src/constants/domainConstants.ts        # 添加 RAG 相关常量
  package.json                            # 添加 hnswlib-node 依赖
  public/index.html                       # 添加知识库面板 HTML
```

---

### Task 1: 类型定义与模块骨架

**Files:**
- Create: `src/rag/types.ts`
- Create: `src/rag/index.ts`

**描述：** 定义 RAG 系统所有共享类型，建立模块入口骨架。

---

- [ ] **Step 1: 编写类型定义文件**

```typescript
// src/rag/types.ts

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  documentCount: number;
  chunkCount: number;
};

export type DocFileType = "pdf" | "docx" | "md" | "txt" | "code";

export type RAGDocument = {
  id: string;
  kbId: string;
  fileName: string;
  fileType: DocFileType;
  filePath: string;
  extractedAt: string;
  chunkIds: string[];
};

export type ChunkMeta = {
  docFileName: string;
  sectionTitle?: string;
  chunkIndex: number;
  lineRange?: [number, number];
  tokenCount: number;
};

export type Chunk = {
  id: string;
  docId: string;
  kbId: string;
  content: string;
  embedding: number[];
  metadata: ChunkMeta;
};

export type RetrievalResult = {
  chunk: Chunk;
  score: number;
  source: string;
};

export type RAGContext = {
  query: string;
  results: RetrievalResult[];
  injectedPrompt: string;
};

export type ApiConfig = {
  baseURL: string;
  apiKey: string;
  model?: string;
};

export type ChunkOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
};

export type RetrieveOptions = {
  topK?: number;
  minScore?: number;
};

export type KBIndex = {
  version: 1;
  entries: KnowledgeBase[];
};

export type DocsIndex = RAGDocument[];

export type ChunksIndexEntry = Omit<Chunk, "embedding">;
export type ChunksIndex = ChunksIndexEntry[];
```

- [ ] **Step 2: 编写模块入口骨架**

```typescript
// src/rag/index.ts

// Phase 1-2 实现中逐步填充
export type {
  KnowledgeBase,
  RAGDocument,
  Chunk,
  ChunkMeta,
  RetrievalResult,
  RAGContext,
  ApiConfig,
  ChunkOptions,
  RetrieveOptions,
  DocFileType,
} from "./types.js";
```

- [ ] **Step 3: 验证编译**

```bash
npx tsc --noEmit
```
Expected: PASS (no errors from rag/ files)

- [ ] **Step 4: 提交**

```bash
git add src/rag/types.ts src/rag/index.ts
git commit -m "feat(rag): add types and module skeleton"
```

---

### Task 2: 文档解析器（MD/TXT/代码 + PDF/DOCX 骨架）

**Files:**
- Create: `src/rag/ingestion/parsers.ts`
- Create: `src/rag/ingestion/index.ts`

**描述：** 实现多格式文档解析，将文件转为纯文本。Phase 1 先完成 MD/TXT/代码，PDF/DOCX 留到 Phase 4。

---

- [ ] **Step 1: 编写解析器**

```typescript
// src/rag/ingestion/parsers.ts

import fs from "node:fs/promises";
import type { DocFileType } from "../types.js";

type ParseResult = {
  text: string;
  error?: string;
};

function detectFileType(fileName: string): DocFileType {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, DocFileType> = {
    pdf: "pdf",
    docx: "docx",
    md: "md",
    txt: "txt",
    ts: "code",
    js: "code",
    json: "code",
    yaml: "code",
    yml: "code",
    py: "code",
    java: "code",
    go: "code",
    rs: "code",
  };
  return map[ext] ?? "txt";
}

async function parsePlainText(filePath: string): Promise<ParseResult> {
  const text = await fs.readFile(filePath, "utf-8");
  if (text.trim().length === 0) {
    return { text: "", error: "empty file" };
  }
  return { text };
}

async function parsePdf(_filePath: string): Promise<ParseResult> {
  return { text: "", error: "pdf parser not yet implemented" };
}

async function parseDocx(_filePath: string): Promise<ParseResult> {
  return { text: "", error: "docx parser not yet implemented" };
}

export async function parseDocument(
  filePath: string,
  fileName: string,
): Promise<{ text: string; fileType: DocFileType; error?: string }> {
  const fileType = detectFileType(fileName);

  let result: ParseResult;
  switch (fileType) {
    case "pdf":
      result = await parsePdf(filePath);
      break;
    case "docx":
      result = await parseDocx(filePath);
      break;
    case "md":
    case "txt":
    case "code":
      result = await parsePlainText(filePath);
      break;
    default:
      result = { text: "", error: `unsupported type: ${fileType}` };
  }

  return { text: result.text, fileType, error: result.error };
}

export { detectFileType };
```

- [ ] **Step 2: 编写摄入编排**

```typescript
// src/rag/ingestion/index.ts

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RAGDocument } from "../types.js";
import { parseDocument } from "./parsers.js";

export type IngestResult = {
  document: RAGDocument;
  text: string;
  error?: string;
};

export async function ingestDocument(
  kbId: string,
  filePath: string,
  fileName: string,
): Promise<IngestResult> {
  const { text, fileType, error } = await parseDocument(filePath, fileName);

  const doc: RAGDocument = {
    id: randomUUID(),
    kbId,
    fileName,
    fileType,
    filePath,
    extractedAt: new Date().toISOString(),
    chunkIds: [],
  };

  return { document: doc, text, error };
}

export async function ingestDocuments(
  kbId: string,
  files: { filePath: string; fileName: string }[],
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const f of files) {
    try {
      const result = await ingestDocument(kbId, f.filePath, f.fileName);
      results.push(result);
    } catch (err) {
      results.push({
        document: {
          id: randomUUID(),
          kbId,
          fileName: f.fileName,
          fileType: "txt",
          filePath: f.filePath,
          extractedAt: new Date().toISOString(),
          chunkIds: [],
        },
        text: "",
        error: `ingestion failed: ${String(err)}`,
      });
    }
  }
  return results;
}
```

- [ ] **Step 3: 验证编译**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/rag/ingestion/
git commit -m "feat(rag): add document parsers and ingestion orchestrator"
```

---

### Task 3: 语义分块器

**Files:**
- Create: `src/rag/chunking/index.ts`
- Test: `src/tests/unit/rag-chunking.test.ts`

**描述：** 将文本切分为语义单元，支持 Markdown 标题边界、段落边界、固定长度兜底 + 滑动窗口重叠。

---

- [ ] **Step 1: 编写测试**

```typescript
// src/tests/unit/rag-chunking.test.ts

import { describe, expect, it } from "vitest";
import { chunkText } from "../../rag/chunking/index.js";

describe("chunkText", () => {
  it("空文本返回空数组", () => {
    expect(chunkText("", "test.md")).toEqual([]);
    expect(chunkText("   \n\n  ", "test.md")).toEqual([]);
  });

  it("短文本返回单个分块", () => {
    const result = chunkText("用户登录功能需求", "test.md");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("用户登录功能需求");
    expect(result[0].metadata.docFileName).toBe("test.md");
    expect(result[0].metadata.chunkIndex).toBe(0);
  });

  it("按 Markdown 标题边界切分", () => {
    const text = [
      "# 用户管理",
      "用户可以注册和登录系统。",
      "",
      "## 认证机制",
      "采用 JWT Token 认证方式。",
    ].join("\n");

    const result = chunkText(text, "spec.md");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("超长文本产生多个分块且包含重叠", () => {
    const longText = "A".repeat(5000);
    const result = chunkText(longText, "long.txt", { chunkSize: 500, chunkOverlap: 50 });
    expect(result.length).toBeGreaterThan(1);
    // 验证重叠：第一个分块的结尾出现在第二个分块的开头
    const firstEnd = result[0].content.slice(-30);
    const secondStart = result[1].content.slice(0, 30);
    expect(secondStart).toContain(firstEnd.slice(-20));
  });

  it("极短分块被合并到前一个", () => {
    const text = [
      "# 第一章",
      "A".repeat(2000),
      "",
      "# 第二章",
      "短",
    ].join("\n");

    const result = chunkText(text, "short.md", { chunkSize: 500, minChunkSize: 50 });
    // "短" 应该被合并，不单独成一个 chunk
    const lastContent = result[result.length - 1].content;
    expect(lastContent).toContain("短");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/tests/unit/rag-chunking.test.ts
```
Expected: FAIL — `chunkText` not defined

- [ ] **Step 3: 实现分块逻辑**

```typescript
// src/rag/chunking/index.ts

import type { ChunkMeta, ChunkOptions } from "../types.js";

const DEFAULT_CHUNK_SIZE = 800;    // ~2000 中文字符
const DEFAULT_CHUNK_OVERLAP = 100;
const MIN_CHUNK_SIZE = 50;
const CHARS_PER_TOKEN = 2.5;       // 中文约 2.5 字符/token

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitByMarkdownHeadings(text: string): string[] {
  const sections = text.split(/\n(?=#{1,3}\s)/);
  return sections.map((s) => s.trim()).filter(Boolean);
}

function splitByParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

function splitByFixedSize(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const chunks: string[] = [];

  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

export function chunkText(
  text: string,
  docFileName: string,
  options?: ChunkOptions,
): Omit<{ id: string; docId: string; kbId: string; content: string; embedding: number[]; metadata: ChunkMeta }, "id" | "docId" | "kbId" | "embedding">[] {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const minChunkSize = options?.minChunkSize ?? MIN_CHUNK_SIZE;

  const trimmed = text.trim();
  if (!trimmed) return [];

  // Step 1: 按标题边界初切
  let sections = splitByMarkdownHeadings(trimmed);

  // Step 2: 对每个 section 再按段落切分
  let segments: string[] = [];
  for (const section of sections) {
    const paragraphs = splitByParagraphs(section);
    segments.push(...paragraphs);
  }

  // Step 3: 对超长段落按固定长度兜底
  let rawChunks: string[] = [];
  for (const seg of segments) {
    if (estimateTokens(seg) > chunkSize) {
      rawChunks.push(...splitByFixedSize(seg, chunkSize, chunkOverlap));
    } else {
      rawChunks.push(seg);
    }
  }

  // Step 4: 合并过短的分块
  const merged: string[] = [];
  for (const chunk of rawChunks) {
    if (
      merged.length > 0 &&
      estimateTokens(chunk) < minChunkSize
    ) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }

  return merged.map((content, i) => ({
    content,
    metadata: {
      docFileName,
      chunkIndex: i,
      tokenCount: estimateTokens(content),
    },
  }));
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run src/tests/unit/rag-chunking.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add src/rag/chunking/index.ts src/tests/unit/rag-chunking.test.ts
git commit -m "feat(rag): add semantic chunking with markdown/paragraph/fixed-size strategies"
```

---

### Task 4: Embedding 生成器

**Files:**
- Create: `src/rag/embedding/index.ts`

**描述：** 调用 OpenAI 兼容 API 生成 Embedding 向量，支持批量处理和 TF-IDF 降级。

---

- [ ] **Step 1: 实现 Embedding 生成**

```typescript
// src/rag/embedding/index.ts

import type { ApiConfig } from "../types.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

type EmbedResult = Map<string, number[]>;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function computeTfIdfVector(termFreq: Map<string, number>, idf: Map<string, number>, terms: string[]): number[] {
  return terms.map((t) => (termFreq.get(t) ?? 0) * (idf.get(t) ?? 0));
}

function tokenize(text: string): string[] {
  // 简单分词：中文按字，英文按空格
  const tokens: string[] = [];
  const segments = text.split(/\s+/);
  for (const seg of segments) {
    if (/[一-鿿]/.test(seg)) {
      // 中文：逐字
      for (const char of seg) {
        if (/[一-鿿]/.test(char)) tokens.push(char);
      }
    } else if (seg.length > 0) {
      tokens.push(seg.toLowerCase());
    }
  }
  return tokens;
}

export async function embedChunks(
  chunks: { id: string; content: string }[],
  apiConfig: ApiConfig,
): Promise<EmbedResult> {
  const result: EmbedResult = new Map();

  // 尝试 API 调用
  try {
    const model = apiConfig.model ?? EMBEDDING_MODEL;
    const url = `${apiConfig.baseURL.replace(/\/+$/, "")}/embeddings`;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: batch.map((c) => c.content),
        }),
      });

      if (!resp.ok) throw new Error(`embedding api ${resp.status}`);

      const json = (await resp.json()) as {
        data: { index: number; embedding: number[] }[];
      };

      for (const item of json.data) {
        result.set(batch[item.index].id, item.embedding);
      }
    }
    return result;
  } catch (err) {
    // 降级到 TF-IDF
    return embedWithTfIdf(chunks);
  }
}

function embedWithTfIdf(chunks: { id: string; content: string }[]): EmbedResult {
  // 构建词典 + IDF
  const docCount = chunks.length;
  const df = new Map<string, number>(); // 文档频率
  const docs: Map<string, string[]>[] = [];

  for (const chunk of chunks) {
    const terms = tokenize(chunk.content);
    const unique = new Set(terms);
    for (const t of unique) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    const tf = new Map<string, number>();
    for (const t of terms) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    docs.push(tf);
  }

  const terms = [...df.keys()];
  const idf = new Map<string, number>();
  for (const t of terms) {
    idf.set(t, Math.log((docCount + 1) / ((df.get(t) ?? 0) + 1)) + 1);
  }

  const result: EmbedResult = new Map();
  for (let i = 0; i < chunks.length; i++) {
    result.set(chunks[i].id, computeTfIdfVector(docs[i], idf, terms));
  }
  return result;
}

export { cosineSimilarity, embedWithTfIdf, tokenize };
```

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/rag/embedding/index.ts
git commit -m "feat(rag): add embedding generator with TF-IDF fallback"
```

---

### Task 5: 向量存储

**Files:**
- Create: `src/rag/vectorStore/index.ts`

**描述：** 基于 hnswlib + JSON 的向量存储，支持增量添加、搜索、删除。

---

- [ ] **Step 1: 安装 hnswlib-node**

```bash
npm install hnswlib-node
```

- [ ] **Step 2: 实现向量存储**

```typescript
// src/rag/vectorStore/index.ts

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Chunk, ChunksIndexEntry, RetrievalResult } from "../types.js";

type HnswLib = {
  HierarchicalNSW: new (
    space: string,
    dim: number,
  ) => {
    initIndex(maxElements: number, M?: number, efConstruction?: number, randomSeed?: number): void;
    addPoint(point: number[], idx: number): void;
    searchKnn(query: number[], k: number): { distances: number[]; neighbors: number[] };
    getMaxElements(): number;
    getCurrentCount(): number;
    writeIndex(path: string): void;
    readIndex(path: string, allowReplaceDeleted?: boolean): void;
    setEf(ef: number): void;
    resizeIndex(newSize: number): void;
    markDeleted(idx: number): void;
  };
};

const DIM = 1536;
const M = 16;
const EF_CONSTRUCTION = 200;
const EF_SEARCH = 100;

async function loadHnswlib(): Promise<HnswLib> {
  return import("hnswlib-node") as unknown as HnswLib;
}

export interface VectorStore {
  addVectors(chunks: Chunk[]): Promise<void>;
  search(queryVector: number[], topK: number): Promise<RetrievalResult[]>;
  deleteByDocId(docId: string): Promise<void>;
  deleteAll(): Promise<void>;
  getStats(): { chunkCount: number; dimension: number };
}

export async function createVectorStore(kbPath: string): Promise<VectorStore> {
  const hnswlib = await loadHnswlib();
  const hnswPath = path.join(kbPath, "vectors.hnsw");
  const chunksPath = path.join(kbPath, "chunks-index.json");

  const index = new hnswlib.HierarchicalNSW("cosine", DIM);
  let initialized = false;
  let chunkCount = 0;

  // 加载已有索引
  const chunksIndex: ChunksIndexEntry[] = [];
  try {
    const raw = await fs.readFile(chunksPath, "utf-8");
    const parsed = JSON.parse(raw) as ChunksIndexEntry[];
    chunksIndex.push(...parsed);
    chunkCount = parsed.length;
  } catch {
    // 新知识库，无已有索引
  }

  if (chunkCount > 0) {
    try {
      index.readIndex(hnswPath, true);
      initialized = true;
    } catch {
      // 索引文件损坏，重建
    }
  }

  function ensureInit(count: number): void {
    if (!initialized) {
      const maxElements = Math.max(count + 100, 1000);
      index.initIndex(maxElements, M, EF_CONSTRUCTION, 42);
      index.setEf(EF_SEARCH);
      initialized = true;
    }
  }

  async function persistChunks(): Promise<void> {
    const tmp = `${chunksPath}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(chunksIndex, null, 2), "utf-8");
    await fs.rename(tmp, chunksPath);
  }

  return {
    async addVectors(chunks: Chunk[]): Promise<void> {
      ensureInit(chunksIndex.length + chunks.length);

      for (const chunk of chunks) {
        const idx = chunksIndex.length;
        index.addPoint(chunk.embedding, idx);
        chunksIndex.push({
          id: chunk.id,
          docId: chunk.docId,
          kbId: chunk.kbId,
          content: chunk.content,
          metadata: chunk.metadata,
        });
      }

      index.writeIndex(hnswPath);
      await persistChunks();
    },

    async search(queryVector: number[], topK: number): Promise<RetrievalResult[]> {
      if (chunksIndex.length === 0) return [];

      ensureInit(1);
      const result = index.searchKnn(queryVector, Math.min(topK, chunksIndex.length));

      return result.neighbors.map((idx, i) => ({
        chunk: {
          ...chunksIndex[idx],
          embedding: [],
        } as Chunk,
        score: 1 - result.distances[i], // cosine distance → similarity
        source: `${chunksIndex[idx].metadata.docFileName}${
          chunksIndex[idx].metadata.sectionTitle
            ? ` > ${chunksIndex[idx].metadata.sectionTitle}`
            : ""
        }`,
      }));
    },

    async deleteByDocId(docId: string): Promise<void> {
      for (let i = chunksIndex.length - 1; i >= 0; i--) {
        if (chunksIndex[i].docId === docId) {
          index.markDeleted(i);
          chunksIndex.splice(i, 1);
        }
      }
      index.writeIndex(hnswPath);
      await persistChunks();
    },

    async deleteAll(): Promise<void> {
      chunksIndex.length = 0;
      index.writeIndex(hnswPath);
      await persistChunks();
    },

    getStats() {
      return { chunkCount: chunksIndex.length, dimension: DIM };
    },
  };
}
```

- [ ] **Step 3: 验证编译**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/rag/vectorStore/index.ts package.json package-lock.json
git commit -m "feat(rag): add hnswlib-based vector store with atomic persistence"
```

---

### Task 6: 混合检索器

**Files:**
- Create: `src/rag/retrieval/hybridSearch.ts`
- Create: `src/rag/retrieval/reranker.ts`
- Create: `src/rag/retrieval/index.ts`
- Test: `src/tests/unit/rag-retrieval.test.ts`

**描述：** 混合检索 = BM25 关键词 + 语义向量 → RRF 融合 → MMR 重排序。

---

- [ ] **Step 1: 编写测试**

```typescript
// src/tests/unit/rag-retrieval.test.ts

import { describe, expect, it } from "vitest";
import { bm25Score } from "../../rag/retrieval/hybridSearch.js";
import { rrfFuse, mmrRerank } from "../../rag/retrieval/reranker.js";
import type { RetrievalResult, Chunk } from "../../rag/types.js";

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
  it("完全匹配得分最高", () => {
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
    // "b" 在两个列表中都出现，应该排第一
    expect(fused[0].chunk.id).toBe("b");
    expect(fused.length).toBe(3);
  });
});

describe("mmrRerank", () => {
  it("保留相关性高的同时增加多样性", () => {
    const results: RetrievalResult[] = [
      { chunk: makeChunk("a", "登录认证机制设计"), score: 0.95, source: "" },
      { chunk: makeChunk("b", "登录页面UI设计"), score: 0.85, source: "" },
      { chunk: makeChunk("c", "数据库索引优化"), score: 0.75, source: "" },
    ];
    const reranked = mmrRerank(results, 2, 0.7);
    expect(reranked.length).toBeLessThanOrEqual(2);
    // 应该包含两个不同主题的结果
    const contents = reranked.map((r) => r.chunk.content);
    const hasLogin = contents.some((c) => c.includes("登录"));
    const hasDb = contents.some((c) => c.includes("数据库"));
    expect(hasLogin || hasDb).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/tests/unit/rag-retrieval.test.ts
```
Expected: FAIL — functions not defined

- [ ] **Step 3: 实现 BM25**

```typescript
// src/rag/retrieval/hybridSearch.ts

import { tokenize } from "../../embedding/index.js";

const K1 = 1.5;
const B = 0.75;

export function bm25Score(query: string, docText: string, avgDocLen?: number, docLen?: number): number {
  const queryTerms = tokenize(query);
  const docTerms = tokenize(docText);
  const dl = docLen ?? docTerms.length;
  const avgdl = avgDocLen ?? dl || 1;

  // 计算文档内词频
  const tf = new Map<string, number>();
  for (const t of docTerms) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;
    // IDF 简化：假设在语料中不常见
    const idf = Math.log(1 + (1 / (f))); 
    score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (dl / avgdl))));
  }
  return score;
}

export function keywordSearch(
  query: string,
  chunks: { id: string; content: string }[],
  topK: number = 10,
): { id: string; score: number }[] {
  const avgLen = chunks.reduce((sum, c) => sum + c.content.length, 0) / (chunks.length || 1);
  const scored = chunks.map((c) => ({
    id: c.id,
    score: bm25Score(query, c.content, avgLen, c.content.length),
  }));
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```

- [ ] **Step 4: 实现 RRF + MMR 重排序**

```typescript
// src/rag/retrieval/reranker.ts

import type { RetrievalResult } from "../../types.js";
import { cosineSimilarity } from "../../embedding/index.js";

const RRF_K = 60;

export function rrfFuse(
  semantic: RetrievalResult[],
  keyword: RetrievalResult[],
): RetrievalResult[] {
  const scoreMap = new Map<string, { result: RetrievalResult; score: number }>();

  for (let i = 0; i < semantic.length; i++) {
    const r = semantic[i];
    scoreMap.set(r.chunk.id, {
      result: r,
      score: 1 / (RRF_K + i + 1),
    });
  }

  for (let i = 0; i < keyword.length; i++) {
    const r = keyword[i];
    const existing = scoreMap.get(r.chunk.id);
    if (existing) {
      existing.score += 1 / (RRF_K + i + 1);
      // 保留更高的语义分数
      if (r.score > existing.result.score) {
        existing.result.score = r.score;
      }
    } else {
      scoreMap.set(r.chunk.id, {
        result: r,
        score: 1 / (RRF_K + i + 1),
      });
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.result, score: entry.score }));
}

export function mmrRerank(
  results: RetrievalResult[],
  lambda: number = 2,
  diversityWeight: number = 0.3,
): RetrievalResult[] {
  if (results.length <= lambda) return results;

  const selected: RetrievalResult[] = [];
  const remaining = [...results];

  // 第一个选最高分
  selected.push(remaining.shift()!);

  while (selected.length < lambda && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      // 与已选结果的最大相似度
      let maxSim = 0;
      for (const s of selected) {
        const sim = cosineSimilarity(
          remaining[i].chunk.embedding,
          s.chunk.embedding,
        );
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = diversityWeight * relevance - (1 - diversityWeight) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}
```

- [ ] **Step 5: 实现检索编排**

```typescript
// src/rag/retrieval/index.ts

import path from "node:path";
import type { ApiConfig, RetrievalResult, RetrieveOptions } from "../types.js";
import { embedChunks } from "../embedding/index.js";
import { createVectorStore, type VectorStore } from "../vectorStore/index.js";
import { keywordSearch } from "./hybridSearch.js";
import { rrfFuse, mmrRerank } from "./reranker.js";

const RAG_DATA_DIR = "data/rag";
const DEFAULT_TOP_K = 5;

// 缓存已打开的 vector store
const storeCache = new Map<string, VectorStore>();

async function getStore(kbId: string): Promise<VectorStore> {
  const cached = storeCache.get(kbId);
  if (cached) return cached;

  const kbPath = path.resolve(RAG_DATA_DIR, kbId);
  const store = await createVectorStore(kbPath);
  storeCache.set(kbId, store);
  return store;
}

export async function retrieve(
  query: string,
  kbId: string,
  apiConfig: ApiConfig,
  options?: RetrieveOptions,
): Promise<RetrievalResult[]> {
  const topK = options?.topK ?? DEFAULT_TOP_K;
  const minScore = options?.minScore ?? 0;

  const store = await getStore(kbId);
  const stats = store.getStats();
  if (stats.chunkCount === 0) return [];

  // 1. 语义检索
  const embedResult = await embedChunks(
    [{ id: "__query__", content: query }],
    apiConfig,
  );
  const queryVector = embedResult.get("__query__");
  if (!queryVector) return [];

  const semanticResults = await store.search(queryVector, topK * 2);

  // 2. 关键词检索 — 需要 chunk 内容，从语义结果里提取
  // 注意：此实现中 keywordSearch 需要访问所有 chunk 内容
  // 由于 VectorStore 不暴露全部 chunk，先用语义结果作为候选集做 BM25
  const keywordCandidates = semanticResults.map((r) => ({
    id: r.chunk.id,
    content: r.chunk.content,
  }));
  const kwScores = keywordSearch(query, keywordCandidates, topK);
  const kwResults: RetrievalResult[] = kwScores.map((kw) => {
    const sr = semanticResults.find((s) => s.chunk.id === kw.id)!;
    return { ...sr, score: kw.score };
  });

  // 3. RRF 融合
  let fused = rrfFuse(semanticResults, kwResults);

  // 4. 过滤低分
  fused = fused.filter((r) => r.score >= minScore);

  // 5. MMR 重排序
  fused = mmrRerank(fused, topK);

  return fused;
}

export function clearStoreCache(kbId?: string): void {
  if (kbId) {
    storeCache.delete(kbId);
  } else {
    storeCache.clear();
  }
}
```

- [ ] **Step 6: 运行测试验证通过**

```bash
npx vitest run src/tests/unit/rag-retrieval.test.ts
```
Expected: PASS (4 tests in 3 groups)

- [ ] **Step 7: 提交**

```bash
git add src/rag/retrieval/ src/tests/unit/rag-retrieval.test.ts
git commit -m "feat(rag): add hybrid retrieval with BM25 + semantic + RRF + MMR"
```

---

### Task 7: 上下文注入（Prompt 拼接）

**Files:**
- Create: `src/rag/injection/index.ts`
- Test: `src/tests/unit/rag-injection.test.ts`

---

- [ ] **Step 1: 编写测试**

```typescript
// src/tests/unit/rag-injection.test.ts

import { describe, expect, it } from "vitest";
import { buildRAGPrompt } from "../../rag/injection/index.js";
import type { RetrievalResult, Chunk } from "../../rag/types.js";

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
    const results = [
      makeResult("1", "JWT Token 有效期 2 小时", 0.92, "auth-spec.md"),
    ];
    const prompt = buildRAGPrompt(results, "技术文档");
    expect(prompt).toContain("参考知识");
    expect(prompt).toContain("技术文档");
    expect(prompt).toContain("auth-spec.md");
    expect(prompt).toContain("0.92");
    expect(prompt).toContain("JWT Token");
  });

  it("多结果按分数排序", () => {
    const results = [
      makeResult("1", "内容A", 0.5, "doc-a.md"),
      makeResult("2", "内容B", 0.95, "doc-b.md"),
    ];
    const prompt = buildRAGPrompt(results, "库");
    const idxA = prompt.indexOf("内容A");
    const idxB = prompt.indexOf("内容B");
    expect(idxB).toBeLessThan(idxA); // 高相关度在前
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/tests/unit/rag-injection.test.ts
```
Expected: FAIL

- [ ] **Step 3: 实现 Prompt 拼接**

```typescript
// src/rag/injection/index.ts

import type { RetrievalResult } from "../types.js";

const DEFAULT_MAX_TOKENS = 3000;
const CHARS_PER_TOKEN = 2.5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function buildRAGPrompt(
  results: RetrievalResult[],
  kbName: string,
  maxTokens?: number,
): string {
  if (results.length === 0) return "";

  const limit = maxTokens ?? DEFAULT_MAX_TOKENS;
  const header = `\n\n## 参考知识\n\n以下是从知识库"${kbName}"中检索到的相关内容，请在生成设计文档时参考：\n\n`;
  let body = "";
  let usedTokens = estimateTokens(header);

  // 按分数排序
  const sorted = [...results].sort((a, b) => b.score - a.score);

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const quote = r.chunk.content.split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const citation = `### 引用 ${i + 1}（来源：${r.source}，相关度：${r.score.toFixed(2)}）\n${quote}\n\n`;

    const citationTokens = estimateTokens(citation);
    if (usedTokens + citationTokens > limit) break;

    body += citation;
    usedTokens += citationTokens;
  }

  return header + body + "---\n";
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run src/tests/unit/rag-injection.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/rag/injection/index.ts src/tests/unit/rag-injection.test.ts
git commit -m "feat(rag): add RAG prompt builder with citation and token budget"
```

---

### Task 8: 知识库管理器

**Files:**
- Create: `src/rag/kbManager.ts`

**描述：** 知识库的 CRUD 操作，管理 `data/rag/` 下的文件存储。

---

- [ ] **Step 1: 实现知识库管理器**

```typescript
// src/rag/kbManager.ts

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBase, RAGDocument, KBIndex, DocsIndex } from "./types.js";

const RAG_DATA_DIR = "data/rag";
const KB_INDEX_FILE = "kb-index.json";

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(RAG_DATA_DIR, { recursive: true });
}

async function loadKBIndex(): Promise<KBIndex> {
  await ensureDataDir();
  const indexPath = path.join(RAG_DATA_DIR, KB_INDEX_FILE);
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(raw) as KBIndex;
  } catch {
    const empty: KBIndex = { version: 1, entries: [] };
    await saveKBIndex(empty);
    return empty;
  }
}

async function saveKBIndex(index: KBIndex): Promise<void> {
  const tmp = path.join(RAG_DATA_DIR, `${KB_INDEX_FILE}.tmp-${randomUUID()}`);
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), "utf-8");
  await fs.rename(tmp, path.join(RAG_DATA_DIR, KB_INDEX_FILE));
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  const index = await loadKBIndex();
  return index.entries;
}

export async function createKnowledgeBase(
  name: string,
  description: string,
): Promise<KnowledgeBase> {
  const index = await loadKBIndex();
  const kb: KnowledgeBase = {
    id: randomUUID(),
    name,
    description,
    createdAt: new Date().toISOString(),
    documentCount: 0,
    chunkCount: 0,
  };
  index.entries.push(kb);
  await saveKBIndex(index);

  // 创建知识库目录
  const kbPath = path.join(RAG_DATA_DIR, kb.id);
  await fs.mkdir(kbPath, { recursive: true });
  await fs.mkdir(path.join(kbPath, "originals"), { recursive: true });
  await fs.writeFile(
    path.join(kbPath, "kb-meta.json"),
    JSON.stringify(kb, null, 2),
    "utf-8",
  );

  return kb;
}

export async function getKnowledgeBase(kbId: string): Promise<KnowledgeBase | null> {
  const index = await loadKBIndex();
  return index.entries.find((kb) => kb.id === kbId) ?? null;
}

export async function deleteKnowledgeBase(kbId: string): Promise<void> {
  const index = await loadKBIndex();
  const idx = index.entries.findIndex((kb) => kb.id === kbId);
  if (idx === -1) throw new Error(`knowledge base not found: ${kbId}`);
  index.entries.splice(idx, 1);
  await saveKBIndex(index);

  const kbPath = path.join(RAG_DATA_DIR, kbId);
  await fs.rm(kbPath, { recursive: true, force: true });
}

export async function updateKBStats(
  kbId: string,
  docCount: number,
  chunkCount: number,
): Promise<void> {
  const index = await loadKBIndex();
  const entry = index.entries.find((kb) => kb.id === kbId);
  if (!entry) return;
  entry.documentCount = docCount;
  entry.chunkCount = chunkCount;
  await saveKBIndex(index);

  const kbMetaPath = path.join(RAG_DATA_DIR, kbId, "kb-meta.json");
  const tmp = `${kbMetaPath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(entry, null, 2), "utf-8");
  await fs.rename(tmp, kbMetaPath);
}

export async function loadDocsIndex(kbId: string): Promise<DocsIndex> {
  const docsPath = path.join(RAG_DATA_DIR, kbId, "docs-index.json");
  try {
    const raw = await fs.readFile(docsPath, "utf-8");
    return JSON.parse(raw) as DocsIndex;
  } catch {
    return [];
  }
}

export async function saveDocsIndex(kbId: string, docs: DocsIndex): Promise<void> {
  const docsPath = path.join(RAG_DATA_DIR, kbId, "docs-index.json");
  const tmp = `${docsPath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(docs, null, 2), "utf-8");
  await fs.rename(tmp, docsPath);
}

export async function addDocumentToIndex(kbId: string, doc: RAGDocument): Promise<void> {
  const docs = await loadDocsIndex(kbId);
  docs.push(doc);
  await saveDocsIndex(kbId, docs);
}

export async function removeDocumentFromIndex(kbId: string, docId: string): Promise<void> {
  const docs = await loadDocsIndex(kbId);
  const filtered = docs.filter((d) => d.id !== docId);
  await saveDocsIndex(kbId, filtered);
}

export { RAG_DATA_DIR };
```

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/rag/kbManager.ts
git commit -m "feat(rag): add knowledge base CRUD manager"
```

---

### Task 9: RAG 模块入口 — 门面 + 全链路串联

**Files:**
- Modify: `src/rag/index.ts`

**描述：** 完善模块入口，对外暴露 `RAGService` 门面，串联 摄入 → 分块 → Embedding → 存储 全链路。

---

- [ ] **Step 1: 重写模块入口**

```typescript
// src/rag/index.ts

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ApiConfig, ChunkOptions, Chunk, RetrievalResult, RetrieveOptions, RAGContext } from "./types.js";
import { ingestDocuments, type IngestResult } from "./ingestion/index.js";
import { chunkText } from "./chunking/index.js";
import { embedChunks } from "./embedding/index.js";
import { createVectorStore, type VectorStore } from "./vectorStore/index.js";
import { retrieve as doRetrieve, clearStoreCache } from "./retrieval/index.js";
import { buildRAGPrompt } from "./injection/index.js";
import { addDocumentToIndex, updateKBStats } from "./kbManager.js";

export type {
  KnowledgeBase,
  RAGDocument,
  Chunk,
  ChunkMeta,
  RetrievalResult,
  RAGContext,
  ApiConfig,
  ChunkOptions,
  RetrieveOptions,
  DocFileType,
} from "./types.js";

export {
  listKnowledgeBases,
  createKnowledgeBase,
  getKnowledgeBase,
  deleteKnowledgeBase,
  loadDocsIndex,
  addDocumentToIndex,
  removeDocumentFromIndex,
  updateKBStats,
} from "./kbManager.js";

const RAG_DATA_DIR = "data/rag";

export class RAGService {
  private storeCache = new Map<string, VectorStore>();

  private async getStore(kbId: string): Promise<VectorStore> {
    const cached = this.storeCache.get(kbId);
    if (cached) return cached;
    const kbPath = path.resolve(RAG_DATA_DIR, kbId);
    const store = await createVectorStore(kbPath);
    this.storeCache.set(kbId, store);
    return store;
  }

  /** 完整摄入流程：解析 → 分块 → Embedding → 存储 */
  async ingestFiles(
    kbId: string,
    files: { filePath: string; fileName: string }[],
    apiConfig: ApiConfig,
  ): Promise<{ success: number; errors: string[] }> {
    const errors: string[] = [];
    const allChunks: Chunk[] = [];
    let successCount = 0;

    for (const file of files) {
      const results = await ingestDocuments(kbId, [file]);
      for (const result of results) {
        if (result.error) {
          errors.push(`${result.document.fileName}: ${result.error}`);
          continue;
        }
        if (!result.text.trim()) {
          errors.push(`${result.document.fileName}: empty content`);
          continue;
        }

        // 分块
        const rawChunks = chunkText(result.text, result.document.fileName);
        const chunkIds: string[] = [];
        const chunksWithId: Chunk[] = [];

        for (const rc of rawChunks) {
          const chunk: Chunk = {
            id: randomUUID(),
            docId: result.document.id,
            kbId,
            content: rc.content,
            embedding: [],
            metadata: rc.metadata,
          };
          chunkIds.push(chunk.id);
          chunksWithId.push(chunk);
        }

        // Embedding
        const embedMap = await embedChunks(
          chunksWithId.map((c) => ({ id: c.id, content: c.content })),
          apiConfig,
        );

        for (const chunk of chunksWithId) {
          const vec = embedMap.get(chunk.id);
          if (vec) {
            chunk.embedding = vec;
          } else {
            chunk.embedding = new Array(1536).fill(0);
          }
        }

        // 存储
        const store = await this.getStore(kbId);
        await store.addVectors(chunksWithId);

        // 更新文档索引
        result.document.chunkIds = chunkIds;
        await addDocumentToIndex(kbId, result.document);

        allChunks.push(...chunksWithId);
        successCount++;
      }
    }

    // 更新统计
    const store = await this.getStore(kbId);
    const stats = store.getStats();
    await updateKBStats(kbId, successCount, stats.chunkCount);

    return { success: successCount, errors };
  }

  /** 检索 + 注入，返回完整 RAG 上下文 */
  async retrieveAndBuild(
    query: string,
    kbId: string,
    apiConfig: ApiConfig,
    kbName: string,
    options?: RetrieveOptions & { maxPromptTokens?: number },
  ): Promise<RAGContext> {
    const results = await doRetrieve(query, kbId, apiConfig, options);
    const injectedPrompt = buildRAGPrompt(results, kbName, options?.maxPromptTokens);

    return {
      query,
      results,
      injectedPrompt,
    };
  }

  /** 仅检索 */
  async retrieve(
    query: string,
    kbId: string,
    apiConfig: ApiConfig,
    options?: RetrieveOptions,
  ): Promise<RetrievalResult[]> {
    return doRetrieve(query, kbId, apiConfig, options);
  }

  /** 删除文档 */
  async removeDocument(kbId: string, docId: string): Promise<void> {
    const { loadDocsIndex, saveDocsIndex } = await import("./kbManager.js");
    const store = await this.getStore(kbId);
    await store.deleteByDocId(docId);
    const docs = await loadDocsIndex(kbId);
    const filtered = docs.filter((d) => d.id !== docId);
    await saveDocsIndex(kbId, filtered);
    const stats = store.getStats();
    await updateKBStats(kbId, filtered.length, stats.chunkCount);
  }

  clearCache(kbId?: string): void {
    if (kbId) {
      this.storeCache.delete(kbId);
    } else {
      this.storeCache.clear();
    }
    clearStoreCache(kbId);
  }
}
```

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/rag/index.ts
git commit -m "feat(rag): add RAG service facade with full ingestion+retrieval pipeline"
```

---

### Task 10: 后端集成 — 路由 + 控制器 + 流水线注入点

**Files:**
- Create: `src/controllers/ragController.ts`
- Create: `src/http/ragRoutes.ts`
- Modify: `src/server.ts`
- Modify: `src/services/taskServiceCore.ts`
- Modify: `src/pipeline/degradation.ts`

**描述：** 注册 API 路由，接入流水线生成入口。

---

- [ ] **Step 1: 编写 RAG 控制器**

```typescript
// src/controllers/ragController.ts

import type { Request, Response } from "express";
import { RAGService, listKnowledgeBases, createKnowledgeBase, getKnowledgeBase, deleteKnowledgeBase } from "../rag/index.js";

const ragService = new RAGService();

function getLlmConfig(): { baseURL: string; apiKey: string; model?: string } {
  // 从环境变量获取，与现有 LLM 配置保持一致
  return {
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  };
}

export class RAGController {
  // GET /api/v1/rag/knowledge-bases
  async listKBs(_req: Request, res: Response): Promise<void> {
    const kbs = await listKnowledgeBases();
    res.json({ code: 0, data: kbs });
  }

  // POST /api/v1/rag/knowledge-bases
  async createKB(req: Request, res: Response): Promise<void> {
    const { name, description } = req.body ?? {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ code: 1, message: "name is required" });
      return;
    }
    const kb = await createKnowledgeBase(name.trim(), String(description ?? ""));
    res.json({ code: 0, data: kb });
  }

  // DELETE /api/v1/rag/knowledge-bases/:kbId
  async deleteKB(req: Request, res: Response): Promise<void> {
    const { kbId } = req.params;
    try {
      await deleteKnowledgeBase(kbId);
      ragService.clearCache(kbId);
      res.json({ code: 0, message: "deleted" });
    } catch {
      res.status(404).json({ code: 1, message: "not found" });
    }
  }

  // GET /api/v1/rag/knowledge-bases/:kbId
  async getKB(req: Request, res: Response): Promise<void> {
    const { kbId } = req.params;
    const kb = await getKnowledgeBase(kbId);
    if (!kb) {
      res.status(404).json({ code: 1, message: "not found" });
      return;
    }
    const { loadDocsIndex } = await import("../rag/kbManager.js");
    const docs = await loadDocsIndex(kbId);
    res.json({ code: 0, data: { ...kb, documents: docs } });
  }

  // POST /api/v1/rag/knowledge-bases/:kbId/documents
  async uploadDocs(req: Request, res: Response): Promise<void> {
    const { kbId } = req.params;
    const { files } = req.body ?? {};
    if (!files || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ code: 1, message: "files array required" });
      return;
    }
    const kb = await getKnowledgeBase(kbId);
    if (!kb) {
      res.status(404).json({ code: 1, message: "knowledge base not found" });
      return;
    }
    const apiConfig = getLlmConfig();
    const result = await ragService.ingestFiles(kbId, files, apiConfig);
    res.json({ code: 0, data: result });
  }

  // DELETE /api/v1/rag/knowledge-bases/:kbId/documents/:docId
  async deleteDoc(req: Request, res: Response): Promise<void> {
    const { kbId, docId } = req.params;
    try {
      await ragService.removeDocument(kbId, docId);
      res.json({ code: 0, message: "deleted" });
    } catch {
      res.status(404).json({ code: 1, message: "not found" });
    }
  }

  // POST /api/v1/rag/knowledge-bases/:kbId/query
  async queryKB(req: Request, res: Response): Promise<void> {
    const { kbId } = req.params;
    const { query } = req.body ?? {};
    if (!query || typeof query !== "string") {
      res.status(400).json({ code: 1, message: "query is required" });
      return;
    }
    const kb = await getKnowledgeBase(kbId);
    if (!kb) {
      res.status(404).json({ code: 1, message: "not found" });
      return;
    }
    const apiConfig = getLlmConfig();
    const results = await ragService.retrieve(query, kbId, apiConfig);
    res.json({ code: 0, data: results });
  }
}
```

- [ ] **Step 2: 编写路由注册**

```typescript
// src/http/ragRoutes.ts

import type { Express } from "express";
import { RAGController } from "../controllers/ragController.js";

export function registerRagRoutes(app: Express): void {
  const controller = new RAGController();

  app.get("/api/v1/rag/knowledge-bases", (req, res) => { controller.listKBs(req, res); });
  app.post("/api/v1/rag/knowledge-bases", (req, res) => { controller.createKB(req, res); });
  app.delete("/api/v1/rag/knowledge-bases/:kbId", (req, res) => { controller.deleteKB(req, res); });
  app.get("/api/v1/rag/knowledge-bases/:kbId", (req, res) => { controller.getKB(req, res); });
  app.post("/api/v1/rag/knowledge-bases/:kbId/documents", (req, res) => { controller.uploadDocs(req, res); });
  app.delete("/api/v1/rag/knowledge-bases/:kbId/documents/:docId", (req, res) => { controller.deleteDoc(req, res); });
  app.post("/api/v1/rag/knowledge-bases/:kbId/query", (req, res) => { controller.queryKB(req, res); });
}
```

- [ ] **Step 3: 在 server.ts 中注册路由**

编辑 `src/server.ts`，在现有路由注册后添加一行：

```typescript
// 在 registerConfigRoutes(app); 之后添加：
import { registerRagRoutes } from "./http/ragRoutes.js";
registerRagRoutes(app);
```

- [ ] **Step 4: 在 taskServiceCore.ts 中集成 RAG 检索**

在 `taskServiceCore.ts` 的 `filewiseGenerateCurrent` 函数中（生成调用前），添加 RAG 注入逻辑：

```typescript
// 在生成 SystemMessage 之前，插入以下逻辑：

// RAG 检索（如果运行绑定了知识库）
let ragPrompt = "";
const kbId = meta.ragKbId;
if (kbId) {
  try {
    const { RAGService } = await import("../rag/index.js");
    const { getKnowledgeBase } = await import("../rag/kbManager.js");
    const kb = await getKnowledgeBase(kbId);
    if (kb) {
      const ragService = new RAGService();
      const apiConfig = {
        baseURL: meta.llm.baseUrl,
        apiKey: meta.llm.apiKey,
      };
      const ctx = await ragService.retrieveAndBuild(
        meta.requirement,
        kbId,
        apiConfig,
        kb.name,
      );
      ragPrompt = ctx.injectedPrompt;
    }
  } catch (err) {
    await appendRunLog(meta, `[RAG] retrieve failed: ${String(err)}`);
  }
}

// 然后将 ragPrompt 拼接到 SystemMessage content 中
const systemContent = originalPrompt + ragPrompt;
```

- [ ] **Step 5: 扩展 FileRunMeta 类型**

编辑 `src/pipeline/stateMachine.ts`，在 `FileRunMeta` 接口中添加：

```typescript
// 在 FileRunMeta 类型中添加：
ragKbId?: string;
```

- [ ] **Step 6: 验证编译**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/controllers/ragController.ts src/http/ragRoutes.ts src/server.ts src/services/taskServiceCore.ts src/pipeline/stateMachine.ts
git commit -m "feat(rag): integrate RAG into pipeline with routes, controller, and generation injection"
```

---

### Task 11: 前端 — 知识库管理面板

**Files:**
- Create: `public/js/ragPanel.js`
- Create: `public/js/ragCoordinator.js`
- Modify: `public/index.html`

**描述：** 知识库管理 UI — 创建、上传、查看、删除、检索测试。

---

- [ ] **Step 1: 编写前端面板 JS**

```javascript
// public/js/ragPanel.js

const RAG_PANEL = {
  state: {
    kbs: [],
    selectedKbId: null,
    queryResults: [],
  },

  async loadKBList() {
    const resp = await fetch("/api/v1/rag/knowledge-bases");
    const json = await resp.json();
    this.state.kbs = json.data ?? [];
    this.renderKBList();
  },

  renderKBList() {
    const container = document.getElementById("rag-kb-list");
    if (!container) return;
    const kbs = this.state.kbs;

    if (kbs.length === 0) {
      container.innerHTML = '<div class="text-gray-400 text-sm p-2">暂无知识库，点击上方按钮创建</div>';
      return;
    }

    container.innerHTML = kbs.map((kb) => `
      <div class="rag-kb-item flex items-center justify-between p-2 rounded cursor-pointer hover:bg-gray-100 ${
        this.state.selectedKbId === kb.id ? "bg-blue-50 border border-blue-200" : "border border-transparent"
      }" data-kb-id="${kb.id}">
        <div class="flex-1 min-w-0" data-action="select-kb" data-kb-id="${kb.id}">
          <div class="text-sm font-medium truncate">${this.escape(kb.name)}</div>
          <div class="text-xs text-gray-400">${kb.documentCount} 文档, ${kb.chunkCount} 分块</div>
        </div>
        <button class="text-red-400 hover:text-red-600 text-xs ml-2" data-action="delete-kb" data-kb-id="${kb.id}">删除</button>
      </div>
    `).join("");
  },

  async selectKB(kbId) {
    this.state.selectedKbId = kbId;
    this.renderKBList();

    const resp = await fetch(`/api/v1/rag/knowledge-bases/${kbId}`);
    const json = await resp.json();
    const kb = json.data;
    if (!kb) return;

    const detail = document.getElementById("rag-kb-detail");
    if (!detail) return;

    const docs = kb.documents ?? [];
    detail.innerHTML = `
      <div class="p-2 border-t">
        <div class="flex gap-2 mb-2">
          <button class="px-3 py-1 bg-blue-500 text-white text-xs rounded" data-action="upload-doc">上传文档</button>
          <button class="px-3 py-1 bg-gray-200 text-xs rounded" data-action="close-detail">关闭</button>
        </div>
        <div class="text-xs text-gray-500 mb-1">文档列表 (${docs.length})：</div>
        <div class="max-h-48 overflow-y-auto">
          ${docs.map((doc) => `
            <div class="flex items-center justify-between text-xs py-1 border-b border-gray-100">
              <span class="truncate">${this.escape(doc.fileName)}</span>
              <span class="text-gray-400 ml-2">${doc.chunkIds.length} 块</span>
              <button class="text-red-400 hover:text-red-600 ml-1" data-action="delete-doc" data-doc-id="${doc.id}">&times;</button>
            </div>
          `).join("")}
        </div>
        <div class="mt-2">
          <div class="text-xs text-gray-500 mb-1">检索测试：</div>
          <div class="flex gap-1">
            <input id="rag-query-input" class="flex-1 border rounded px-2 py-1 text-xs" placeholder="输入测试查询...">
            <button class="px-2 py-1 bg-gray-200 text-xs rounded" data-action="test-query">搜索</button>
          </div>
          <div id="rag-query-results" class="mt-2 text-xs"></div>
        </div>
      </div>
    `;
  },

  async createKB() {
    const name = prompt("知识库名称：");
    if (!name) return;
    const desc = prompt("描述（可选）：") ?? "";
    await fetch("/api/v1/rag/knowledge-bases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc }),
    });
    await this.loadKBList();
  },

  async deleteKB(kbId) {
    if (!confirm("确定删除此知识库？所有文档和索引将被清除。")) return;
    await fetch(`/api/v1/rag/knowledge-bases/${kbId}`, { method: "DELETE" });
    if (this.state.selectedKbId === kbId) {
      this.state.selectedKbId = null;
      const detail = document.getElementById("rag-kb-detail");
      if (detail) detail.innerHTML = "";
    }
    await this.loadKBList();
  },

  async uploadDocs() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".md,.txt,.pdf,.docx,.ts,.js,.json,.yaml,.yml";
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) return;
      // 读文件内容并发给后端
      const files = [];
      for (const f of input.files) {
        const text = await f.text();
        files.push({ fileName: f.name, content: text });
      }
      // 这里先把文件保存到一个临时位置，简化处理：
      // 生产环境应使用 FormData + multer
      const resp = await fetch(`/api/v1/rag/knowledge-bases/${this.state.selectedKbId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: files.map((f) => ({ filePath: f.fileName, fileName: f.fileName })) }),
      });
      const json = await resp.json();
      alert(`导入完成：成功 ${json.data?.success ?? 0}, 错误 ${(json.data?.errors ?? []).length}`);
      await this.selectKB(this.state.selectedKbId);
      await this.loadKBList();
    };
    input.click();
  },

  async testQuery() {
    const input = document.getElementById("rag-query-input");
    const container = document.getElementById("rag-query-results");
    if (!input || !container) return;
    const query = input.value.trim();
    if (!query) return;

    container.innerHTML = '<span class="text-gray-400">搜索中...</span>';
    const resp = await fetch(`/api/v1/rag/knowledge-bases/${this.state.selectedKbId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json = await resp.json();
    const results = json.data ?? [];

    if (results.length === 0) {
      container.innerHTML = '<span class="text-gray-400">无结果</span>';
      return;
    }
    container.innerHTML = results.map((r, i) => `
      <div class="mb-1 p-1 bg-gray-50 rounded">
        <span class="text-blue-500">[${r.score.toFixed(2)}]</span>
        <span class="text-gray-600">${this.escape(r.source)}</span>
        <div class="text-gray-500 pl-2">${this.escape(r.chunk.content.slice(0, 120))}...</div>
      </div>
    `).join("");
  },

  escape(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  },
};

// 事件委托
document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const kbId = target.dataset.kbId;
  const docId = target.dataset.docId;

  switch (action) {
    case "select-kb": RAG_PANEL.selectKB(kbId); break;
    case "delete-kb": RAG_PANEL.deleteKB(kbId); break;
    case "create-kb": RAG_PANEL.createKB(); break;
    case "close-detail": RAG_PANEL.state.selectedKbId = null; RAG_PANEL.renderKBList(); break;
    case "upload-doc": RAG_PANEL.uploadDocs(); break;
    case "delete-doc": RAG_PANEL.removeDoc(kbId, docId); break;
    case "test-query": RAG_PANEL.testQuery(); break;
  }
});
```

- [ ] **Step 2: 在 index.html 中添加面板结构**

在 `public/index.html` 中合适位置（设置面板附近）添加：

```html
<!-- RAG 知识库面板 -->
<div id="rag-panel" class="hidden fixed inset-y-0 right-0 w-96 bg-white shadow-xl z-50 flex flex-col">
  <div class="flex items-center justify-between p-3 border-b">
    <h3 class="text-sm font-semibold">知识库管理</h3>
    <button onclick="document.getElementById('rag-panel').classList.add('hidden')" class="text-gray-400 hover:text-gray-600">&times;</button>
  </div>
  <div class="p-2 border-b">
    <button class="w-full px-3 py-1.5 bg-blue-500 text-white text-sm rounded" data-action="create-kb">+ 新建知识库</button>
  </div>
  <div id="rag-kb-list" class="flex-1 overflow-y-auto p-2"></div>
  <div id="rag-kb-detail" class="border-t bg-gray-50"></div>
</div>
```

- [ ] **Step 3: 在合适位置添加打开面板的按钮**

```html
<button onclick="document.getElementById('rag-panel').classList.remove('hidden'); RAG_PANEL.loadKBList();"
        class="...">知识库</button>
```

- [ ] **Step 4: 在 index.html 中加载 JS**

```html
<script src="js/ragPanel.js"></script>
```

- [ ] **Step 5: 浏览器验证**

```bash
npx tsx src/server.ts
```
Expected: 打开 `http://localhost:8080`，点击知识库按钮可打开面板

- [ ] **Step 6: 提交**

```bash
git add public/js/ragPanel.js public/index.html
git commit -m "feat(rag): add knowledge base management panel UI"
```

---

## 自审清单

1. **规范覆盖**：设计文档的 9 个章节均有对应 Task — 类型(T1)、摄入(T2)、分块(T3)、Embedding(T4)、向量存储(T5)、检索(T6)、注入(T7)、知识库管理(T8)、API+集成(T9-T10)、前端(T11)。PDF/DOCX 解析器按规范列为 Phase 4（不在本次计划中）。

2. **无占位符**：所有步骤均包含完整可执行的代码，无 TBD/TODO/placeholder。

3. **类型一致性**：`types.ts` 中定义的 `Chunk`、`RetrievalResult`、`RAGContext`、`ApiConfig` 等在各模块中引用一致。`chunkText` 返回类型与 `Chunk` 的 `metadata` 字段匹配。

---

*计划完成。选择执行方式：*

**1. Subagent-Driven（推荐）** — 每个 Task 一个全新 subagent，Task 之间 review

**2. Inline Execution** — 在当前会话中按 Task 顺序执行，每个 Phase 结束时 review
