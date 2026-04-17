# JAP-plus SDD 改造计划（08_SDD_软件设计说明书.md）

## 1. 背景与目标

JAP-plus 目前以「01~07」作为架构设计套件的分文件产物，支持 filewise 的生成/审批/回退流程。现新增最终交付能力：生成一份工程可落地的 SDD（Software Design Document，软件设计说明书），并将「01~07」定位为中间产物（默认可隐藏，但仍可查看/调试/回放）。

**核心目标**
- 新增最终交付文件：`08_SDD_软件设计说明书.md`
- `08` 必须在 `01~07` 全部完成后才允许生成（门禁：完成而非必须审批，详见第 4.3 节）
- `08` 以 `01~07` 为“证据源”做一致性约束，减少编造与前后矛盾
- 前端提供开关：用户可选择“展示中间产物（01~07）/ 只看 SDD（08）”
- 以“工程落地”为导向：SDD 需包含可实施的接口、数据、流程、非功能、测试、运维等信息

## 2. SDD 定义（本项目的交付标准）

### 2.1 输出形式
- 单文件 Markdown：`tasks/{runId}/08_SDD_软件设计说明书.md`
- 输出语言：中文

### 2.2 SDD 目录结构（强约束模板）
SDD 章节结构固定，便于稳定生成与验收：
1. 概述（目标/范围/术语/非目标）
2. 总体架构（组件/模块边界、部署形态、关键依赖）
3. 领域模型与数据设计（核心实体、关系、表结构、索引、数据一致性）
4. 核心业务流程与状态机（关键流程、状态迁移、异常/补偿、幂等）
5. API 设计（接口清单、关键接口请求响应、错误码、鉴权）
6. 非功能设计（安全、性能、可用性、可观测性、容量与扩展）
7. 测试与验收（测试策略、验收标准、关键用例）
8. 发布与运维（配置、部署、回滚、监控告警、联调指南）
9. 附录（术语表、约束与假设、参考链接/引用）

### 2.3 一致性与“允许补充”规则
SDD 允许补充 `01~07` 未覆盖内容，但必须满足：
- **不得虚构具体系统事实**：对未被 `01~07` 或用户输入明确给出的细节，必须用“建议/默认方案/可选项”表述
- **实体/表/接口/状态一致性优先**：SDD 中出现的命名应优先引用 `01~07` 中的定义；若新增，需在附录明确标注“新增建议项”
- **引用优先**：优先引用 `01~07` 的正文片段或摘要（将通过“证据块”注入提示词实现）

## 3. 01~07 与 SDD 的映射关系

将现有产物定位为 SDD 的章节输入源：
- 01（产品功能脑图与用例）→ SDD 2、4（边界与用例驱动流程）
- 02（领域模型与物理表结构）→ SDD 3（实体/表/索引/一致性）
- 03（核心业务状态机）→ SDD 4（状态迁移/异常/补偿）
- 04（API 与时序图）→ SDD 5（接口清单/错误码/鉴权）
- 05（验收与测试）→ SDD 7（验收与关键用例）
- 06（前端页面原型）→ SDD 2、7（交互约束/验收口径）
- 07（研发与联调说明）→ SDD 8（部署/运维/联调）

## 4. 技术方案（分阶段交付）

### 4.1 阶段 1：新增 08 文件规格与流水线接入
**目标**：让 filewise 运行态支持 `08`，并落盘到 `tasks/{runId}/`。

**代码改动点**
- 产物命名常量扩展：[domainConstants.ts](file:///workspace/src/constants/domainConstants.ts)
- 文件流水线规格扩展（顺序、spec 映射、类型域）：[taskService.ts](file:///workspace/src/services/taskService.ts)

**验收标准**
- `npx tsc --noEmit` 通过
- `POST /api/v1/tasks/filewise/start` 返回的 `files` 中包含 `08`
- `GET /api/v1/tasks/filewise/:runId` 能返回 08 的状态

**交付**
- 提交并推送 GitHub（阶段完成后）

### 4.2 阶段 2：实现 SDD 专用 Prompt（模板化输出）
**目标**：`08` 生成时使用专用 SDD system prompt + user prompt（固定目录结构 + 约束）。

**代码改动点**
- 新增 SDD system prompt：[promptTexts.ts](file:///workspace/src/constants/promptTexts.ts)
- 新增 prompt builder 并在生成分支接入：[taskService.ts](file:///workspace/src/services/taskService.ts)

**验收标准**
- `npx tsc --noEmit` 通过
- 在 08 生成结果中能看到固定目录结构（章节齐全）

**交付**
- 提交并推送 GitHub（阶段完成后）

### 4.3 阶段 3：用 01~07 正文“证据块”约束 SDD（防编造）
**目标**：将 `01~07` 的正文/关键段落聚合为“证据块”，注入给 08 的提示词，用于一致性约束。

**实现要点**
- 增加聚合函数：读取 `tasks/{runId}/01~07` 的正文并截断（每个文件设定 maxChars），按文件分块拼装
- 仅在 `01~07` 全部完成后允许生成 `08`（门禁）
- 提示词中加入明确规则：实体/接口/表/状态必须来自证据块；无法确定的内容必须以“建议/可选项”表达

**代码改动点**
- `taskService.ts`：新增 `loadArtifactsEvidenceForSdd()`（命名可调整）并在 08 生成流程使用

**验收标准**
- `08` 的提示词输入包含 `01~07` 的证据块
- SDD 输出的实体/接口/表结构与 01~07 一致（抽样人工验收 + 关键字段检查）

**交付**
- 提交并推送 GitHub（阶段完成后）

### 4.4 阶段 4：前端开关（展示/隐藏中间产物 01~07）
**目标**：UI 允许用户选择仅看 SDD 或同时看 01~07。

**实现要点**
- 在设置中新增一个开关（例如：`showIntermediateArtifacts`）
- 文件列表/预览区按开关过滤（关闭时仅展示 08；打开时展示 01~08）
- 不影响后端产物生成与落盘（只是展示策略）

**代码改动点**
- 前端逻辑：[main.js](file:///workspace/public/js/main.js)（设置保存/渲染文件列表处）
- 如需持久化：沿用当前 settings 的 sessionStorage 策略

**验收标准**
- 开关切换后，界面展示符合预期
- 不影响后端任务状态机推进

**交付**
- 提交并推送 GitHub（阶段完成后）

## 5. 测试策略

每个阶段至少满足：
- TypeScript 编译检查：`npx tsc --noEmit`
- 启动检查：`npm run dev` 能启动
- 接口冒烟（curl）：
  - `POST /api/v1/tasks/filewise/start`
  - `GET /api/v1/tasks/filewise/:runId`
  - `POST /api/v1/tasks/filewise/:runId/generate-next`

SDD 质量相关测试（阶段 3 起）：
- 证据块是否注入（在服务端构造 prompt 前可打印长度/摘要到事件日志，避免泄露敏感信息）
- 抽样校验：SDD 中关键实体/接口名是否出现在证据块中

## 6. 提交与发布策略（每阶段一次）
- 每完成一个阶段且通过上述验收后，进行一次 commit + push
- commit message 遵循 Conventional Commits，例如：
  - `feat(sdd): add 08 SDD artifact definition`
  - `feat(sdd): generate SDD with constrained template`
  - `feat(sdd): inject evidence from artifacts into SDD generation`
  - `feat(ui): toggle intermediate artifacts visibility`

## 7. 风险与对策
- Token 泄露风险：推送应避免将 token 固化到 git remote（优先使用一次性认证方式）
- Prompt 过长：证据块需分文件截断，并优先取已审批/已生成关键部分
- 一致性仍可能漂移：SDD 中对“新增建议项”必须显式标注，避免混入“已确定事实”

