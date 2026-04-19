# JAP-Plus 性能提升计划 V3

## 核心目标：从 15-20min 压缩到 8-12min

---

## B1: MCP 预连接与状态可视化（省 30s-5min，解决"老是连接失败"）

### 当前问题

- MCP连接（npx启动3个子进程）无超时，卡住时整个流程阻塞
- 连接仅在需要时触发（生成文件/定稿时），用户无法感知状态
- `tryGenerateWithMcp` 尝试调用不存在的工具，白等一轮

### B1-1: MCP 预连接（服务启动时/工作空间切换时）

**文件**: `src/server.ts`, `src/tools/mcpClient.ts`

方案：

1. `server.ts` 启动后，如果已配置 workspacePath，立即后台尝试 `getSharedClient`
2. `mcpClient.ts` 的 `connect()` 方法给每个server加 **15s超时**，超时视为optional失败跳过
3. 连接结果缓存在 `JapMcpClient` 类上，包含每个server的连接状态

```typescript
// mcpClient.ts 新增
type McpServerStatus = {
  name: string;
  status: "connected" | "disconnected" | "connecting" | "failed";
  error?: string;
  toolNames: string[];
};

class JapMcpClient {
  // 新增：获取各server连接状态
  getServerStatuses(): McpServerStatus[] { ... }

  // 新增：是否有文件生成类工具可用
  hasFileGenerationTools(): boolean { ... }

  // 修改：connect加超时
  async connect(allowedDir: string): Promise<void> {
    // 用 Promise.race + timeout 替代无超时的 await client.connect(transport)
  }
}
```

### B1-2: MCP 状态 API

**文件**: `src/http/configRoutes.ts`, `src/controllers/taskController.ts`（或新controller）

新增端点：

- `GET /api/v1/config/mcp/status` → 返回各server连接状态
- `POST /api/v1/config/mcp/connect` → 手动触发连接/重连
- `POST /api/v1/config/mcp/disconnect` → 断开连接

### B1-3: 前端 MCP 状态展示

**文件**: `public/js/main.js`, `public/index.html`

1. 新增 MCP 状态指示器（类似现有的 LLM chip 和 WS chip）
   - 显示3个server各自状态：filesystem / sequential-thinking / prd-creator
   - 颜色：绿色=已连接，灰色=未连接，红色=连接失败，黄色=连接中
2. 点击状态指示器可展开详情，含"重新连接"按钮
3. 页面加载时自动调用 `/api/v1/config/mcp/status` 获取状态

### B1-4: 生成时跳过不可用的MCP

**文件**: `src/services/taskService.ts` L1493-1520 `tryGenerateWithMcp`

修改逻辑：

1. 先检查 `JapMcpClient.sharedClient` 是否存在且已连接
2. 如果未连接，**直接返回 null**，不尝试 `getSharedClient`（不再在生成流程中触发连接）
3. 如果已连接，检查 `hasFileGenerationTools()`，没有对应工具也直接返回 null
4. 这样已连接的MCP能正常使用，未连接的完全跳过，零等待

```typescript
export async function tryGenerateWithMcp(...): Promise<...> {
  if (process.env.DISABLE_MCP === "true") return null;
  // 新增：如果未连接，不尝试连接
  const existing = JapMcpClient.sharedClient;
  if (!existing || !existing.isConnected()) return null;
  // 新增：如果没有文件生成工具，直接跳过
  if (!existing.hasFileGenerationTools()) return null;
  // 后续正常调用...
}
```

### B1-5: Elicitation 中 MCP 降级为可选

**文件**: `src/services/elicitationService.ts`

1. `processElicitation` deep模式（L248-313）：如果MCP未连接，跳过sequential thinking，用LLM chain-of-thought替代
2. `processFinalize`（L431-472）：如果MCP未连接，直接用 `readProjectContextLocal`（已有）替代 `readProjectContext`，跳过PRD工具

---

## B2: 05/06/07 并行生成（省 40-80s）

### 当前问题

01-04串行是必须的（命名一致性），但05/06/07仅依赖01-04的approved summary，完全可以并行。当前仍串行等3个LLM调用。

### B2-1: 后端批量并行生成 API

**文件**: `src/http/taskRoutes.ts`, `src/controllers/taskController.ts`, `src/services/taskService.ts`

新增端点 `POST /api/v1/tasks/filewise/:runId/generate-detailing-batch`

逻辑：

1. 检查当前状态：01-04必须全部 APPROVED
2. 将05/06/07的状态都设为 GENERATING
3. `Promise.allSettled` 并行调用3次 `runSingleFileGeneration`
4. 每个完成后独立写文件、更新meta、发WS事件
5. 全部完成后统一刷新前端

```typescript
async function generateDetailingBatch(meta: FileRunMeta): Promise<FileRunMeta> {
  const detailingIds: FileId[] = ["05", "06", "07"];
  const approvedSummary = await loadApprovedArtifactSummary(meta);

  // 并行生成
  const results = await Promise.allSettled(
    detailingIds.map(async (fileId) => {
      upsertFileState(meta, fileId, { status: "GENERATING", lastError: null });
      const result = await runSingleFileGeneration(meta, fileId, 1);
      await writeFileBody(meta.workspacePath, meta.runId, fileId, result.content);
      upsertFileState(meta, fileId, {
        status: "GENERATED",
        usedMcp: result.usedMcp,
        toolName: result.toolName,
        fallbackReason: result.fallbackReason,
      });
      return { fileId, result };
    })
  );

  await saveMeta(meta);
  // 发WS事件通知前端
  return meta;
}
```

注意点：

- `runSingleFileGeneration` 内部的 `appendEventLog` 和 `emitTaskScopedEvent` 是线程安全的（append模式），可并行调用
- `saveMeta` 需要在所有文件写完后统一调用一次，避免3次并发写冲突
- auto-approve逻辑：autoRunLoop模式下05/06/07生成后自动approve

### B2-2: 前端 autoRunLoop 适配

**文件**: `public/js/main.js` L747-775 `autoRunLoop`

修改逻辑：

1. 当 `currentFile === "05"` 且 05/06/07 都是 PENDING 时，调用 `generate-detailing-batch`
2. 否则走原有的串行逻辑
3. autoRunLoop 自动approve 05/06/07

### B2-3: 前端文件树实时更新

并行生成时3个文件同时变化，前端需要同时更新3个文件的状态。当前 `updateFileTree` 已支持，但需确保WS事件能正确处理多个文件的并发状态变更。

---

## B3: 上下文裁剪（每次生成省 5-15s，减少幻觉）

### 当前问题

生成每个文件时，`approvedSummary` 包含所有已批准文件的摘要，`evidence`（仅08）包含7个文件的全文片段。很多内容对目标文件无用，白白增加token消耗。

### B3-1: 定义每个文件的精确上下文需求

**文件**: `src/services/taskService.ts` L936-974 `buildModelingPrompt`/`buildDetailingPrompt`

| 目标文件 | 需要的上下文                                    | 不需要的             |
| ---- | ----------------------------------------- | ---------------- |
| 01   | requirement, qa, skill                    | 无（第一个文件）         |
| 02   | requirement, 01摘要(用例名+关系), qa, skill      | 01全文             |
| 03   | requirement, 02摘要(实体名+表结构), qa, skill     | 01全文, 02全文       |
| 04   | requirement, 02摘要, 03摘要(状态+流转), qa, skill | 01全文, 02全文, 03全文 |
| 05   | requirement, 01摘要, 04摘要(API路径列表), skill   | 02/03/06/07内容    |
| 06   | requirement, 01摘要, 04摘要, skill            | 02/03/05/07内容    |
| 07   | requirement, 04摘要(API路径+method), skill    | 01/02/03/05/06内容 |
| 08   | requirement, 01-07结构化约束, qa, skill        | 部分evidence全文     |

### B3-2: 实现选择性摘要加载

**文件**: `src/services/taskService.ts`

新增 `loadSelectiveSummary(meta, targetFileId)` 函数，根据目标文件只加载需要的文件摘要：

```typescript
// 定义哪些文件需要哪些前置文件的摘要
const CONTEXT_DEPENDENCIES: Record<FileId, FileId[]> = {
  "01": [],
  "02": ["01"],
  "03": ["02"],
  "04": ["02", "03"],
  "05": ["01", "04"],
  "06": ["01", "04"],
  "07": ["04"],
  "08": ["01", "02", "03", "04", "05", "06", "07"],
};

async function loadSelectiveSummary(meta: FileRunMeta, targetFileId: FileId): Promise<string> {
  const deps = CONTEXT_DEPENDENCIES[targetFileId] ?? [];
  // 只读取依赖文件的摘要，而非全部
  const records: string[] = [];
  const promises = meta.files
    .filter(f => f.status === "APPROVED" && deps.includes(f.fileId))
    .map(async (file) => { ... }); // 同 loadApprovedArtifactSummary 逻辑但只过滤deps
  ...
}
```

### B3-3: SDD evidence 精准化

**文件**: `src/services/taskService.ts` L1345-1370 `loadSddEvidence`

当前 `maxCharsByFile` 的截断较粗，可以：

- 02 只提取 CREATE TABLE 语句（不含说明文字）
- 03 只提取状态转换边（不含图表描述）
- 04 只提取 paths + methods（不含详细schema定义）

用现有的 `parseTableColumns`/`parseOpenApiSignatures`/`parseStateTransitions` 提取结构化信息替代全文片段。

---

## B5: SDD 生成流程专项优化（省 60-180s，从3+1次LLM调用降至1-2次）

### 当前 SDD 流程耗时分析

SDD（08号文件）是整个流程中最慢的环节，当前需要 **3+1次LLM调用**：

| 步骤  | 函数                               | LLM类型                          | 输入token量(估)                                                 | 估计耗时    |
| --- | -------------------------------- | ------------------------------ | ----------------------------------------------------------- | ------- |
| 1   | `generateSddConstraintsDraft`    | 结构化输出(SddConstraintsSchema)    | evidence 36k + summary 12k + qa 3k + skill 1.8k ~ 53k chars | 30-60s  |
| 2   | `validateSddGate`                | 结构化输出(SddGateValidationSchema) | constraints + precheck + 3个artifact各22k ~ 70k chars         | 30-60s  |
| 3   | `generateSddBodyWithConstraints` | 自由文本生成                         | 完整sddPrompt + constraints JSON ~ 55k chars                  | 60-120s |
| 4   | `recoverSddConstraintsByLlm`(可选) | 结构化输出                          | markdown 26k                                                | 20-40s  |

**总计**：正常情况120-240s，含recovery可达160-280s（近3-5分钟！）

### 关键发现

1. **步骤1和2输入大量重复** — 步骤1传了 evidence(36k)，步骤2又传了 artifacts 的 clampText(各22k)，02/03/04内容传了两遍
2. **步骤1的constraints可从本地解析直接构建** — 已有 `parseTableColumns`/`parseOpenApiSignatures`/`parseStateTransitions`，能直接提取出 SddConstraints 的大部分字段
3. **步骤2（gate validation）在 precheck 全通过时价值极低** — 代码已让 gate 不通过也不阻断（L1683-1697），precheck 已经覆盖了 API/表/状态机的对齐检查
4. **步骤3的prompt同时包含evidence全文和constraints JSON** — 二者有大量重叠，constraints 已经是 evidence 的精炼版

### B5-1: 本地构建 SddConstraints，省掉步骤1的LLM调用

**文件**: `src/services/taskService.ts`

当前 `generateSddConstraintsDraft` 用LLM提取结构化约束，但我们已经有 `parseTableColumns`/`parseOpenApiSignatures`/`parseStateTransitions` 三个本地解析器，可以直接构建 SddConstraints 的主体：

```typescript
async function buildSddConstraintsLocally(snapshot: SddInputSnapshot): Promise<SddConstraints> {
  // 从02提取表结构
  const tableMap = parseTableColumns(snapshot.files["02"]);
  const tables: SddTableConstraint[] = Array.from(tableMap.entries()).map(([name, cols]) => ({
    name,
    primaryKey: "id", // 默认值
    requiredColumns: Array.from(cols),
    indexes: [],
  }));

  // 从04提取API
  const apiSet = parseOpenApiSignatures(snapshot.files["04"]);
  const apis: SddApiConstraint[] = Array.from(apiSet).map((sig) => {
    const [method, path] = sig.split(" ");
    return {
      method: method || "GET",
      path: path || "/",
      auth: "unknown" as const,
      requiredRequestFields: [],
      requiredResponseFields: [],
      errorCodes: [],
    };
  });

  // 从03提取状态机
  const transitionKeys = parseStateTransitions(snapshot.files["03"]);
  // 简单聚合为单状态机（LLM可以补充细节，但基础骨架已有）
  const states = new Set<string>();
  const transitions: SddStateTransition[] = [];
  for (const key of transitionKeys) {
    const [from, to] = key.split("->");
    if (from) states.add(from);
    if (to) states.add(to);
    transitions.push({ from: from || "", to: to || "", trigger: "", notes: "" });
  }
  const stateMachines: SddStateMachineConstraint[] = transitions.length > 0
    ? [{ name: "default", states: Array.from(states), transitions }]
    : [];

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    apis,
    tables,
    stateMachines,
    notes: "auto-generated from local parsing",
  };
}
```

**优势**：

- 零LLM调用，几十毫秒完成
- 不会产生幻觉（直接从已生成的文件中提取）
- 100%覆盖实际内容，不会遗漏

**劣势**：

- auth/errorCodes/trigger 等细节字段为默认值
- 状态机可能需要合并多个（当前简化为单状态机）

**折中方案**：本地构建constraints骨架，仅在 `runLocalSddPrecheck` 发现冲突时才用LLM修正。大部分情况下本地构建就够了。

### B5-2: precheck 通过时跳过 gate LLM调用，省掉步骤2

**文件**: `src/services/taskService.ts` L1668-1697

当前逻辑：`precheck` -> `gate`（LLM），gate不通过也不阻断。

优化逻辑：

```typescript
const precheck = await runLocalSddPrecheck(snapshot, constraints);

let validation: SddGateValidation;
if (precheck.passed && precheck.conflicts.length === 0) {
  // precheck完全通过，无需LLM gate校验
  validation = { passed: true, conflicts: [], meta: { skippedGate: true } };
} else {
  // precheck有问题，用LLM做深度校验
  const gateResult = await validateSddGate(meta, snapshot, constraints, precheck);
  validation = gateResult.validation;
}
```

**收益**：当01-07质量较好时，直接省掉30-60s的gate LLM调用。

### B5-3: 合并constraints构建和SDD正文生成为单次LLM调用

**文件**: `src/services/taskService.ts`

当前分两步：先提取constraints，再生成正文。可以合并为：

1. 本地解析构建constraints骨架（B5-1）
2. 将constraints骨架作为约束条件，直接让LLM一次性生成包含constraints JSON块的SDD正文

这样步骤1和步骤3合并，省掉一次LLM调用。

```typescript
async function generateSddWithLocalConstraints(
  meta: FileRunMeta,
  snapshot: SddInputSnapshot,
  constraints: SddConstraints,
  fallbackContextOnly: boolean,
  minimalist: boolean,
): Promise<string> {
  const model = createModel(meta, fallbackContextOnly ? 35000 : 45000);
  const prompt = [
    // 不再传完整evidence，只传精炼的constraints + 简要summary
    `Requirement:`,
    clampText(snapshot.requirement, FILEWISE_CONTEXT_LIMIT),
    ``,
    `Artifact summaries:`,
    clampText(snapshot.approvedSummary, 8000), // 缩减
    ``,
    `Structured constraints (extracted from 01-07, MUST follow):`,
    JSON.stringify(constraints),
    ``,
    `QA snapshot:`,
    clampText(snapshot.qa, 2000), // 缩减
    ``,
    `Skill context:`,
    clampText(snapshot.skill, 1500),
  ].join("\n");

  // system prompt 中要求同时输出正文和constraints块
  const response = await model.invoke([
    new SystemMessage(SDD_NODE_SYSTEM_PROMPT +
      `\n\n约束JSON已经提取完毕，你必须在SDD正文末尾原样包含以下约束块：\n` +
      `<!-- SDD_CONSTRAINTS_JSON_BEGIN -->\n` +
      JSON.stringify(constraints, null, 2) +
      `\n<!-- SDD_CONSTRAINTS_JSON_END -->`),
    new HumanMessage(prompt),
  ]);
  // ...
}
```

**收益**：省掉一次LLM调用，同时减少了输入token量（不传evidence全文）。但正文末尾的constraints块是本地直接拼接的，不需要LLM重新生成。

### B5-4: SDD evidence 裁剪（与B3-3联动）

**文件**: `src/services/taskService.ts` L1345-1370 `loadSddEvidence`

如果B5-1+5-3方案采用，SDD正文生成不再需要evidence全文。但如果仍需要evidence作为参考：

当前 `maxCharsByFile` 总量约 46000 chars，优化后：

- 01: 用例名列表（解析 Mermaid 的节点名）~500 chars（原5000）
- 02: CREATE TABLE语句 ~3000 chars（原8000）
- 03: 状态转换边列表 ~1500 chars（原6000）
- 04: paths+methods摘要 ~4000 chars（原12000）
- 05: Feature/Scenario标题 ~800 chars（原5000）
- 06: 跳过（HTML对SDD无结构价值）~0 chars（原5000）
- 07: API endpoint列表 ~500 chars（原5000）

**总缩减**：从46000 chars -> ~10300 chars，减少约77%的evidence token量

### B5-5: 优化后的SDD流程对比

| 步骤                   | 优化前            | 优化后                    | 省时            |
| -------------------- | -------------- | ---------------------- | ------------- |
| constraints提取        | LLM调用(30-60s)  | 本地解析(<100ms)           | 30-60s        |
| local precheck       | 不变             | 不变                     | -             |
| gate validation      | LLM调用(30-60s)  | precheck通过时跳过          | 30-60s        |
| SDD正文生成              | LLM调用(60-120s) | LLM调用(40-80s，因token减少) | 20-40s        |
| constraints recovery | 可能需要(20-40s)   | 不需要(本地解析不会失败)          | 20-40s        |
| **总计**               | **140-280s**   | **40-80s**             | **省100-200s** |

---

## B4: Fail-Fast 提前校验（避免全流程返工）

### 当前问题

01-07生成后只做格式检查（markdown/yaml/json是否为空），直到08才做跨文件一致性校验。如果04的API路径与02/03不一致，要跑完全部8个文件才发现。

### B4-1: 04 生成后立即做 API 一致性快检

**文件**: `src/services/taskService.ts` `filewiseGenerateCurrent`

04生成成功后（status=GENERATED），调用已有的 `parseOpenApiSignatures` 解析04，与02的 `parseTableColumns`、03的 `parseStateTransitions` 做基础对齐检查。

```typescript
// 在 filewiseGenerateCurrent 中，fileId === "04" 且生成成功后
if (fileId === "04" && newStatus === "GENERATED") {
  const quickCheck = await runQuickConsistencyCheck(meta, "04");
  if (quickCheck.warnings.length > 0) {
    // 记录warning到event log，但不阻断流程
    await appendEventLog(meta.workspacePath, meta.runId, "QUICK_CHECK_WARNING", {
      fileId: "04",
      warnings: quickCheck.warnings.slice(0, 5),
    });
  }
  if (quickCheck.errors.length > 0) {
    // 记录error，标记文件可能有质量问题
    await appendEventLog(meta.workspacePath, meta.runId, "QUICK_CHECK_ERROR", {
      fileId: "04",
      errors: quickCheck.errors.slice(0, 5),
    });
  }
}
```

### B4-2: 基础格式校验

对每个文件生成后做最基础的格式验证：

| 文件  | 校验规则                                   | 失败处理           |
| --- | -------------------------------------- | -------------- |
| 01  | 包含 `graph` 关键字（Mermaid格式）              | warning        |
| 02  | 包含 `CREATE TABLE` 或 `表` 关键字            | warning        |
| 03  | 包含 `-->` 或 `->` 状态转换标记                 | warning        |
| 04  | 包含 `paths:` 和 HTTP method关键字，或者是有效YAML | error + 自动重试1次 |
| 05  | 包含 `Feature:` 和 `Scenario:`            | warning        |
| 06  | 包含 `<!DOCTYPE html>` 或 `<html`         | error + 自动重试1次 |
| 07  | 可被 `JSON.parse` 且包含 `item` 或 `request` | error + 自动重试1次 |

### B4-3: 前端展示校验结果

Quick check warning/error 通过 WS 事件推送到前端，在日志中显示为黄色警告/红色错误，用户可据此决定是否手动重试某个文件。

---

## 实施顺序与依赖关系（按风险从低到高排列，先止血再动刀）

### 第1阶段：止血提速（风险最低，立刻见效）

**B1-4**（生成路径快速跳过不可用MCP）：立刻止血，MCP未连接时零等待跳过

### 第2阶段：SDD 减调用减 token（中低风险，不改变质量模型）

**B5-2**（precheck 通过时跳过 gate）+ **B5-4**（evidence 裁剪）：
- 先减 token 量和调用数，但不先动"本地完全替代 constraints"
- precheck 通过跳过 gate 是安全的——precheck 已覆盖 API/表/状态机对齐
- evidence 裁剪只影响输入参考量，不影响输出质量

### 第3阶段：并行生成（中风险，需要加写锁）

**B2**（05/06/07 并行）：
- 前提是先加 run 级写锁/批量 saveMeta 策略，避免3个并发写冲突
- autoRunLoop 需适配 batch API
- 前端文件树需处理3个文件同时状态变更

### 第4阶段：激进重构（高风险，对质量模型影响大）

**B5-1**（本地 constraints 全量替代）+ **B4**（fail-fast）：
- B5-1 本地构建 constraints 骨架会丢失 auth/errorCodes/trigger 细节字段
- 状态机简化为单状态机可能不够（复杂业务有多个状态机）
- B4 fail-fast 对04做格式+一致性校验，如果过严可能误报导致不必要的重试
- 这两项放最后，待前3阶段稳定后再评估是否需要

### 执行路线图

```
阶段1 ──→ B1-4 (MCP快速跳过)           风险:低  省时:30s-5min
  |
  v
阶段2 ──→ B5-2 (precheck通过跳过gate)   风险:低  省时:30-60s
       + B5-4 (evidence裁剪77%)         风险:低  省时:20-40s
  |
  v
阶段3 ──→ B1-1~3 (MCP预连接+前端展示)   风险:中  省时:30s-2min(后续)
       + B2 (05/06/07并行)              风险:中  省时:40-80s
  |
  v
阶段4 ──→ B5-1 (本地constraints替代)    风险:高  省时:30-60s
       + B5-3 (合并正文+constraints)    风险:高  省时:省1次LLM
       + B4 (fail-fast校验)            风险:中  省时:避免返工
       + B3 (上下文裁剪)                风险:低  省时:每文件5-15s
```

---

## 回滚开关（每阶段只开一个主开关）

所有优化项通过环境变量控制，出问题可立即关闭回滚：

| 环境变量 | 控制的优化项 | 默认值 | 说明 |
|---------|-----------|-------|------|
| `SKIP_MCP_ON_DISCONNECTED` | B1-4 (MCP快速跳过) | `true` | 未连接时跳过MCP，不尝试连接 |
| `SKIP_GATE_ON_PRECHECK_PASS` | B5-2 (precheck通过跳过gate) | `true` | precheck零冲突时跳过gate LLM调用 |
| `ENABLE_SDD_EVIDENCE_PRUNING` | B5-4 (evidence裁剪) | `true` | 用结构化摘要替代全文片段 |
| `ENABLE_DETAILING_BATCH` | B2 (05/06/07并行) | `false` | 启用后端批量并行生成API |
| `ENABLE_SDD_LOCAL_CONSTRAINTS` | B5-1 (本地constraints替代) | `false` | 用本地解析替代LLM提取constraints |
| `ENABLE_QUICK_CHECK` | B4 (fail-fast校验) | `false` | 04生成后做一致性快检 |

使用方式：
- 阶段1上线时只开 `SKIP_MCP_ON_DISCONNECTED=true`
- 阶段2上线时加开 `SKIP_GATE_ON_PRECHECK_PASS=true` + `ENABLE_SDD_EVIDENCE_PRUNING=true`
- 阶段3上线时加开 `ENABLE_DETAILING_BATCH=true`
- 阶段4按需开启其余开关
- 任何阶段出现问题，关闭对应开关即可回滚

---

## 验收方案（A/B 基准测试）

### 测试方法

固定选取 20 个历史 run（覆盖简单/中等/复杂业务场景），分 A/B 两组各 10 个：
- A组：所有优化开关关闭（baseline）
- B组：逐阶段开启优化开关

### 核心指标

| 指标 | 含义 | 目标 |
|------|------|------|
| 端到端总耗时 | 从任务创建到08完成的总时间 | 下降 >=40% |
| 08 生成成功率 | SDD生成后状态为 GENERATED/APPROVED 的比例 | 不下降 |
| Gate 冲突率 | SDD Gate 校验存在 error 级冲突的比例 | 不上升 |
| 重试次数 | 01-08 各文件平均重试次数 | 不上升 |
| 失败可见性延迟 | 从文件生成失败到前端展示的时间 | 不恶化 |

### 每阶段验收标准

| 阶段 | 必须通过 | 观察指标 |
|------|---------|---------|
| 阶段1 | MCP未连接时生成流程不卡住 | 01-07总耗时对比 |
| 阶段2 | 08成功率不下降，gate冲突率不上升 | SDD总耗时对比 |
| 阶段3 | 05/06/07并行生成无状态覆盖、前端无闪烁 | 05-07总耗时对比 |
| 阶段4 | 08成功率不下降，quick-check误报率<10% | 全流程耗时对比 |

---

## 预计收益（保守估算）

| 阶段 | 优化项 | 省时 | 条件 |
|------|--------|------|------|
| 1 | B1-4 MCP快速跳过 | 30s-5min | MCP连接失败时收益最大 |
| 2 | B5-2+B5-4 gate跳过+evidence裁剪 | 50-100s | 每次SDD生成都受益 |
| 3 | B2 05/06/07并行 | 40-80s | 3个LLM调用变1个等待时间 |
| 4 | B5-1+B5-3 本地constraints+合并 | 50-100s | 需验证质量不回退 |
| 4 | B3 上下文裁剪 | 每文件5-15s | token减少直接降低TTFT |
| 4 | B4 fail-fast | 避免全流程返工 | 当且仅当早期文件有问题时 |

**保守合计**：阶段1-3完成后，正常流程从15-20min压缩到8-12min；SDD环节从3-5分钟压缩到1.5-2分钟。

阶段4若验证通过，SDD可进一步压缩到1分钟以内。
