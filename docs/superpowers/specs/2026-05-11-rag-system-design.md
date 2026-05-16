# RAG 知识库系统设计文档

> 日期：2026-05-11  
> 状态：待审批  
> 关联：improvement-suggestions-2026-05-11.md

---

## 1. 动机与目标

### 1.1 现状

JAP-plus 的流水线在生成设计文档时，上下文完全依赖 prompt 窗口内的内容（需求文本 + 已审批产出物摘要），上限 10,000 字符（`pipeline/degradation.ts:27`）。系统没有能力引用外部知识，例如：

- 公司现有的技术方案文档
- 已有的 API 规范或数据模型定义
- 行业/项目特定的术语和业务规则
- 历史项目中积累的设计模式

### 1.2 目标

为 JAP-plus 增加 RAG（Retrieval-Augmented Generation）能力，使流水线在生成设计文档时能够自动检索并引用知识库中的相关内容。

### 1.3 成功标准

- [ ] 支持 PDF、DOCX、MD、TXT、代码文件（`.ts`、`.js`、`.json`、`.yaml`）的文本提取
- [ ] 检索延迟 < 500ms（知识库 < 1000 个分块）
- [ ] 检索结果带溯源引用（每条注入的知识片段标注来源文档和位置）
- [ ] 前端提供知识库管理 UI（上传、浏览、删除、查看分块）
- [ ] 与现有文件级流水线无缝集成（知识库可在创建运行时选择绑定）
- [ ] 零外部服务依赖（纯 Node.js + 文件系统实现，无需 Docker/数据库）

---

## 2. 架构设计

### 2.1 模块划分

```
src/rag/
├── index.ts                  # 模块入口，导出 RAG 门面
├── ingestion/
│   ├── index.ts              # 文档摄入编排
│   ├── parsers.ts            # 多格式解析器（PDF/DOCX/MD/TXT/代码）
│   └── textExtractor.ts      # 纯文本提取 + 元数据收集
├── chunking/
│   ├── index.ts              # 分块策略入口
│   ├── semanticChunker.ts    # 语义边界分块（按段落/章节/代码块）
│   └── overlapWindow.ts      # 滑动窗口重叠
├── embedding/
│   ├── index.ts              # Embedding 生成器
│   └── openaiEmbedder.ts     # 调用 OpenAI 兼容 Embedding API
├── vectorStore/
│   ├── index.ts              # 向量存储接口
│   ├── fileStore.ts          # 文件系统实现（hnswlib + JSON 元数据）
│   └── metadata.ts           # 分块元数据管理
├── retrieval/
│   ├── index.ts              # 检索编排
│   ├── hybridSearch.ts       # 混合检索（BM25 关键词 + 语义向量）
│   └── reranker.ts           # 重排序（按相关度 + 多样性）
├── injection/
│   ├── index.ts              # 上下文注入
│   └── promptBuilder.ts      # 拼接知识片段到 system prompt
├── kbManager.ts              # 知识库管理（CRUD）
└── types.ts                  # 共享类型定义
```

### 2.2 核心类型

```typescript
// src/rag/types.ts

type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  documentCount: number;
  chunkCount: number;
};

type Document = {
  id: string;
  kbId: string;
  fileName: string;
  fileType: "pdf" | "docx" | "md" | "txt" | "code";
  filePath: string;       // 原始文件路径
  extractedAt: string;
  chunkIds: string[];
};

type Chunk = {
  id: string;
  docId: string;
  kbId: string;
  content: string;
  embedding: number[];    // 向量，维度取决于模型
  metadata: {
    docFileName: string;
    sectionTitle?: string;  // 所属章节标题
    chunkIndex: number;     // 在文档中的分块序号
    lineRange?: [number, number]; // 原文行号范围
    tokenCount: number;     // 估算 token 数
  };
};

type RetrievalResult = {
  chunk: Chunk;
  score: number;           // 相关性分数 0-1
  source: string;          // 来源引用文本
};

type RAGContext = {
  query: string;           // 原始查询（需求文本）
  results: RetrievalResult[];
  injectedPrompt: string;  // 拼接后的完整 system prompt 补充
};
```

### 2.3 与现有架构的集成点

```
                    ┌─────────────────────────┐
                    │    taskServiceCore.ts    │
                    │    degradation.ts        │
                    │                          │
                    │  生成前调用：             │
                    │  ragContext = await       │
                    │    ragService.retrieve(   │
                    │      requirement,         │
                    │      kbId,                │
                    │      fileId               │
                    │    )                      │
                    │                          │
                    │  ragContext.injectedPrompt│
                    │  拼接到 SystemMessage     │
                    └──────────┬──────────────┘
                               │
┌──────────────────────────────┼──────────────────────┐
│  新增 HTTP 路由               │                      │
│  src/http/ragRoutes.ts       │    src/rag/           │
│                              │    ├── kbManager.ts   │
│  /api/v1/rag/knowledge-bases │    ├── ingestion/     │
│  /api/v1/rag/kb/:id/docs     │    ├── chunking/      │
│  /api/v1/rag/kb/:id/chunks   │    ├── embedding/     │
│  /api/v1/rag/kb/:id/query    │    ├── vectorStore/   │
│                              │    ├── retrieval/     │
│                              │    └── injection/     │
└──────────────────────────────┴───────────────────────┘

数据存储：
  data/rag/
  ├── kb-index.json            # 知识库列表
  ├── {kbId}/
  │   ├── kb-meta.json         # 知识库元数据
  │   ├── docs-index.json      # 文档索引
  │   ├── chunks-index.json    # 分块索引
  │   ├── vectors.hnsw         # hnswlib 向量数据
  │   └── originals/           # 上传的原始文件副本
  │       ├── {docId}.pdf
  │       └── ...
```

---

## 3. 各模块详细设计

### 3.1 文档摄入（ingestion）

**职责**：接收文件路径/上传文件，解析为纯文本。

**解析策略**：

| 格式 | 解析方式 | 依赖 |
|------|---------|------|
| `.md` / `.txt` | 直接读取 | 无（`fs.readFileSync`） |
| `.pdf` | 提取文本流 | `pdf-parse`（纯 JS） |
| `.docx` | 解压 XML → 提取 `<w:t>` 节点 | `mammoth`（纯 JS） |
| `.ts` / `.js` / `.json` / `.yaml` | 直接读取，保留代码结构 | 无 |

**接口**：

```typescript
// src/rag/ingestion/index.ts
async function ingestDocument(
  kbId: string,
  filePath: string,
  fileName: string
): Promise<Document>;

async function ingestDocuments(
  kbId: string,
  files: { filePath: string; fileName: string }[]
): Promise<Document[]>;
```

**错误处理**：
- 文件不存在 → 明确错误 + 跳过
- 解析失败 → 记录错误文档，继续处理其余文件
- 空文件 → 跳过并告警

### 3.2 文本分块（chunking）

**职责**：将长文本切分为适合 embedding 的语义单元。

**分块策略**（按优先级）：
1. **Markdown 标题边界**：按 `#`/`##`/`###` 自然切分
2. **段落边界**：双换行符 `\n\n`
3. **固定长度兜底**：800 token / ~2000 字符，重叠 100 token

**参数**：
- `chunkSize`: 800 tokens（默认，适合中文文本）
- `chunkOverlap`: 100 tokens（保证上下文连贯）
- `minChunkSize`: 50 tokens（过短的分块合并到上一个）

**接口**：

```typescript
// src/rag/chunking/index.ts
function chunkText(
  text: string,
  docFileName: string,
  options?: { chunkSize?: number; chunkOverlap?: number }
): Omit<Chunk, "id" | "docId" | "kbId" | "embedding">[];
```

### 3.3 Embedding 生成（embedding）

**职责**：调用 LLM API 将文本转为向量。

**复用现有配置**：
- 使用用户已配置的 OpenAI 兼容 API（`baseURL` + `apiKey` + `model`）
- 默认 model: `text-embedding-3-small`（1536 维）
- 批量处理：每次发送最多 20 个分块，减少 API 调用次数

**接口**：

```typescript
// src/rag/embedding/index.ts
async function embedChunks(
  chunks: Pick<Chunk, "id" | "content">[],
  apiConfig: { baseURL: string; apiKey: string; model?: string }
): Promise<Map<string, number[]>>;
```

**降级策略**：（API 不可用时）
- 使用基于 TF-IDF 的稀疏向量作为后备（`node-tfidf` 或无依赖实现）
- 仅支持关键词检索，语义检索自动降级

### 3.4 向量存储（vectorStore）

**职责**：持久化向量并支持相似度搜索。

**选型：hnswlib + JSON**

选择理由：
- `hnswlib-node` 是轻量 C++ 库的 Node 绑定，零外部服务依赖
- 支持增量添加（无需重建索引）
- 10,000 个 1536 维向量的搜索延迟 < 10ms
- JSON 文件存储元数据（分块内容、来源信息），hnsw 文件存储向量

**接口**：

```typescript
// src/rag/vectorStore/index.ts
interface VectorStore {
  addVectors(chunks: Chunk[]): Promise<void>;
  search(queryVector: number[], topK: number): Promise<RetrievalResult[]>;
  deleteByDocId(docId: string): Promise<void>;
  deleteByKbId(kbId: string): Promise<void>;
  getStats(): { chunkCount: number; dimension: number };
}

function createVectorStore(kbPath: string): Promise<VectorStore>;
```

**存储结构**：
```
data/rag/{kbId}/
├── kb-meta.json          # { id, name, description, createdAt, docCount, chunkCount }
├── docs-index.json       # Document[]
├── chunks-index.json     # Chunk[] (不含 embedding 字段，向量存在 .hnsw)
└── vectors.hnsw          # hnswlib 二进制索引
```

### 3.5 混合检索（retrieval）

**职责**：结合关键词和语义检索，返回最相关的分块。

**检索流程**：
1. **Query 预处理**：对用户需求文本做去停用词、关键词提取
2. **语义检索**：query → embedding → hnsw 最近邻搜索 → top 2K 候选
3. **关键词检索**：BM25 评分（`natural` 或 `jieba` 分词）→ top K 候选
4. **融合排序**：RRF（Reciprocal Rank Fusion）合并两组结果
5. **重排序**：按相关性分数 + MMR（最大边际相关）去重，返回 top 5-10

**接口**：

```typescript
// src/rag/retrieval/index.ts
async function retrieve(
  query: string,
  kbId: string,
  apiConfig: { baseURL: string; apiKey: string; model?: string },
  options?: { topK?: number; minScore?: number }
): Promise<RetrievalResult[]>;
```

### 3.6 上下文注入（injection）

**职责**：将检索结果拼接为可用于 LLM prompt 的上下文片段。

**注入格式**（中文场景）：

```markdown
## 参考知识

以下是从知识库"{kbName}"中检索到的相关内容，请在生成设计文档时参考：

### 引用 1（来源：技术方案-v2.3.md，相关度：0.92）
> 用户认证采用 JWT + Refresh Token 双 token 机制，
> Access Token 有效期 2 小时，Refresh Token 有效期 7 天。

### 引用 2（来源：API规范.yaml，相关度：0.85）
> 所有 API 响应格式统一为 { code: number, data: T, message: string }

---
```

**token 预算控制**：
- 知识片段总 token 数 ≤ 当前文件上下文限制的 30%（即 ≤ 3000 tokens）
- 超出部分按相关性分数截断
- 每条引用标注源文件名和相关度分数

**接口**：

```typescript
// src/rag/injection/index.ts
function buildRAGPrompt(
  results: RetrievalResult[],
  kbName: string,
  maxTokens?: number
): string;
```

---

## 4. API 设计

### 4.1 知识库管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/rag/knowledge-bases` | 列出所有知识库 |
| `POST` | `/api/v1/rag/knowledge-bases` | 创建知识库 |
| `DELETE` | `/api/v1/rag/knowledge-bases/:kbId` | 删除知识库 |
| `GET` | `/api/v1/rag/knowledge-bases/:kbId` | 获取知识库详情 |

### 4.2 文档管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/rag/knowledge-bases/:kbId/documents` | 上传文档（multipart） |
| `GET` | `/api/v1/rag/knowledge-bases/:kbId/documents` | 列出文档 |
| `DELETE` | `/api/v1/rag/knowledge-bases/:kbId/documents/:docId` | 删除文档 |

### 4.3 检索

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/rag/knowledge-bases/:kbId/query` | 检索知识片段（调试用） |

### 4.4 流水线集成

| 方法 | 路径 | 说明 |
|------|------|------|
| `PATCH` | `/api/v1/tasks/filewise/:runId/rag` | 为运行绑定/切换知识库 |

---

## 5. 前端设计

### 5.1 知识库管理面板

新增一个侧边面板（或设置页内新 tab），包含：

```
┌─────────────────────────────────────────┐
│  知识库管理                              │
│  ┌─────────────────────────────────┐    │
│  │ [+ 新建知识库]                   │    │
│  ├─────────────────────────────────┤    │
│  │ 我的公司文档    [3 文档, 42 分块] │    │
│  │ 项目API规范    [1 文档, 18 分块]  │    │
│  │ 历史设计方案    [5 文档, 67 分块] │    │
│  └─────────────────────────────────┘    │
│                                          │
│  选中知识库后显示：                        │
│  ┌─────────────────────────────────┐    │
│  │ [上传文档]  [删除]  [重建索引]    │    │
│  │                                  │    │
│  │ 文档列表：                        │    │
│  │ 技术方案-v2.3.md    42分块  ✓    │    │
│  │ API规范.yaml        18分块  ✓    │    │
│  │ 数据模型.md         12分块  ⏳   │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### 5.2 流水线绑定

在文件级流水线启动界面（或运行中设置），增加知识库选择：

```
创建新运行
├── 需求描述：[________________]
├── 知识库：  [我的公司文档  ▼]  (可选)
└── [开始]
```

### 5.3 检索结果预览（调试用）

知识库面板中增加检索测试：

```
输入测试查询：[________________] [搜索]

结果：
1. [0.92] JWT + Refresh Token... (来源: 技术方案-v2.3.md)
2. [0.85] API 响应格式统一... (来源: API规范.yaml)
3. [0.71] 数据库命名规范... (来源: 数据模型.md)
```

---

## 6. 实施计划

### Phase 1：核心检索链路（3-4 天）

```
目标：能检索，能注入，能看到效果

1. src/rag/types.ts — 类型定义
2. src/rag/ingestion/ — 文档解析（MD/TXT 先行）
3. src/rag/chunking/ — 语义分块
4. src/rag/embedding/ — Embedding 生成
5. src/rag/vectorStore/ — 向量存储 + 搜索
6. src/rag/retrieval/ — 混合检索
7. src/rag/injection/ — Prompt 拼接

验收：命令行脚本能完成 文档 → 索引 → 检索 → 生成 prompt 的完整链路
```

### Phase 2：后端集成（2-3 天）

```
目标：接入现有流水线，API + 控制器可用

1. src/rag/kbManager.ts — 知识库 CRUD
2. src/http/ragRoutes.ts — API 路由
3. src/controllers/ragController.ts — 请求处理
4. taskServiceCore.ts — 在生成方法中接入 RAG（可选绑定知识库）
5. meta.json 扩展 — 记录运行绑定的 kbId

验收：通过 API 创建知识库、上传文档、在流水线中检索生效
```

### Phase 3：前端（2-3 天）

```
目标：用户可操作知识库

1. 新建 js/ragPanel.js — 知识库面板模块
2. 新建 js/ragCoordinator.js — 编排逻辑
3. index.html — 添加知识库面板 HTML
4. 流水线启动入口 — 知识库选择下拉
5. 生成结果页 — 显示引用溯源

验收：通过 UI 完成知识库创建、文档上传、流水线中看到知识引用
```

### Phase 4：增强（2-3 天）

```
目标：更多格式、性能优化、测试

1. PDF/DOCX 解析器
2. 检索性能优化（缓存 query embedding）
3. 索引重建 UI
4. 单元测试 + Golden test
5. 错误和边界情况处理
```

---

## 7. 关键技术决策

### 7.1 为什么不用 Chroma/Qdrant/Pinecone？

- 本项目定位是零外部依赖、一键启动
- 知识库规模不大（通常 < 1000 分块），hnswlib 完全够用
- 面试展示中，"从零实现向量存储"比"调第三方 API"更能体现工程能力
- 后期可抽象 VectorStore 接口，轻松切换到外部向量数据库

### 7.2 为什么不用 LangChain 的 VectorStore？

- 项目已有 LangChain 依赖，但其 VectorStore 抽象层太重
- 直接使用 `hnswlib-node` 更轻量，更可控
- 面试中能讲清楚"为什么不用 X 而自己实现"本身就是加分项

### 7.3 Embedding 模型选择

- 默认 `text-embedding-3-small`：1536 维，中文效果好，性价比高
- 兼容任何 OpenAI 兼容的 embedding API
- 降级方案：本地 TF-IDF（token-free 模式）

### 7.4 分块大小：800 tokens

- 中文约 400-500 字/token → 800 tokens ≈ 320-400 字
- 对设计文档场景，一个完整的"设计决策"通常在 300-500 字
- 重叠 100 tokens 保证跨块上下文

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| Embedding API 不可用 | 语义检索失效 | TF-IDF 降级，仅关键词检索 |
| hnswlib-node 编译失败 | 向量存储不可用 | 降级为暴力余弦相似度（< 1000 分块可接受） |
| PDF 解析质量差 | 摄入内容不可用 | 提供"粘贴纯文本"作为手动录入备选 |
| 检索结果不相关 | RAG 无正向效果 | 显示相关度分数和来源，让用户自行判断 |
| 知识库过大（> 5000 分块） | 检索变慢 | 加粗粒度分块 + 先关键词过滤再语义检索 |

---

## 9. 测试策略

- **单元测试**：分块逻辑、BM25 评分、prompt 拼接
- **集成测试**：文档摄入 → 分块 → embedding → 存储 → 检索 全链路
- **Golden test**：固定知识库 + 固定查询 → 验证检索结果稳定性和生成质量
- **边界测试**：空文档、超长单行、二进制文件误上传、超大文件

---

*此文档待审批通过后，进入 writing-plans 阶段生成详细实现计划。*
