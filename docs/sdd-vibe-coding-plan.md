# 用 SDD 约束 Vibe Coding：JAP-plus 改造计划

## 1. 目标定义（本项目里的“Vibe Coding 约束”是什么）

本计划的目标不是限制创意，而是把“随意写代码”变成“在 SDD 边界内快速实现”：

- **SDD 作为单一事实源（Source of Truth）**：系统输出的 `08_SDD_软件设计说明书.md` 变成后续编码/修改的约束依据。
- **可执行约束（Executable Constraints）**：从 SDD 中提取结构化约束（实体/表/接口/状态机/错误码/鉴权等），用于自动校验。
- **强门禁（Gate）**：当代码变更与 SDD 冲突时，系统自动给出冲突报告并阻断“进入下一阶段”。
- **可迭代（Human-in-the-loop）**：当冲突出现，用户可以选择：
  - 修改 SDD（更新事实源）
  - 修改代码（回到 SDD 约束内）
  - 标记例外（显式记录原因与影响范围）

## 2. 现状基础（已具备能力）

当前系统已具备：
- 生成最终交付物：`08_SDD_软件设计说明书.md`
- 08 生成时注入 01~07 证据块，降低编造风险
- 08 的生成门禁（需 01~07 完成/审批后生成）
- filewise 流程：start / generate-next / approve / reject / regenerate / save-edit

本计划将在现有 filewise 流程上新增“SDD 约束抽取 + SDD Gate”。

## 3. 总体架构（新增能力模块）

新增三个关键模块：

1) **SDD Constraint Extractor（抽取器）**
- 输入：`08_SDD_软件设计说明书.md`（以及可选 01~07）
- 输出：结构化约束 JSON（例如 `tasks/{runId}/sdd.constraints.json`）

2) **SDD Gate（约束门禁）**
- 输入：结构化约束 + 当前代码/接口/SQL（或其摘要）
- 输出：一致性报告（通过/失败 + 冲突列表）
- 行为：失败则阻断“继续生成/继续发布”动作

3) **SDD-driven Vibe Coding Workflow（约束工作流）**
- 将 Gate 接入现有 filewise 流程（在关键节点执行）
- 前端展示冲突报告，并提供“修复策略”入口

## 4. 结构化约束模型（约束的最小可行集）

第一版约束不追求全覆盖，只做工程落地最关键的“硬约束”：

### 4.1 API 约束（优先级最高）
- endpoint（method + path）
- request/response schema 的关键字段（只校验“必须存在的字段”）
- auth requirement（是否需要鉴权）
- error codes（关键错误码集合）

### 4.2 数据约束
- 表名、主键、关键索引
- 外键关系（可选）
- 关键字段（例如 tenant_id、status）

### 4.3 业务状态机约束
- 核心状态集合
- 状态迁移边（from→to + 触发条件/动作摘要）

### 4.4 非功能约束（软约束）
- 安全（鉴权/审计日志/多租户隔离）
- 可观测性（日志/指标/trace）
- 性能（限流/缓存/分页）

## 5. 分阶段交付计划（每阶段通过测试后提交并推送 GitHub）

### 阶段 1：新增 SDD 约束抽取器（SDD → constraints.json）
**目标**：给定一份 SDD，产出结构化约束 JSON，供 Gate 使用。

实现策略（推荐从稳定性出发）：
- **以“提取”为主而非“理解”为主**：优先要求 SDD 输出时包含“机器可读块”（例如固定标题下的表格/清单/标记块）。
- 在生成 SDD 的 prompt 中强化“输出可提取结构”：
  - API：以表格列出 method/path/auth/req/resp/errorCodes
  - 数据：以表格列出 table/pk/indexes/fields
  - 状态机：以列表列出 states/transitions

交付物：
- `sdd.constraints.json`（落盘到 run 目录）

验收：
- `npx tsc --noEmit`
- 给定示例 SDD，能稳定生成可解析 JSON（字段齐全、schema 稳定）

提交：
- `feat(sdd-gate): extract constraints from sdd`

### 阶段 2：实现 SDD Gate（校验器）——只做“报告”，暂不阻断
**目标**：实现一致性校验逻辑与报告输出，但先不强制阻断流程，便于迭代校验规则。

校验输入（第一版）：
- `sdd.constraints.json`
- `04_RESTful_API契约.yaml`（作为“实现侧 API 事实”）
- `02_领域模型与物理表结构.md`（或从中抽取 DDL）

校验输出：
- `sdd.validation.json`（passed + conflicts）

验收：
- `npx tsc --noEmit`
- 用构造的冲突样例能产出可读冲突报告

提交：
- `feat(sdd-gate): validate artifacts against sdd constraints`

### 阶段 3：接入 Gate 并阻断流程（强门禁）
**目标**：当冲突存在时，阻止进入下一步生成/发布（至少阻断生成 08 或阻断任务 DONE）。

建议门禁点：
- 在 `08` 生成前执行一次 Gate
- 在任务进入 DONE 前再执行一次 Gate（最终兜底）

验收：
- 冲突存在：前端看到明确提示，按钮不可用或返回 409 + 冲突信息
- 冲突修复后：流程恢复

提交：
- `feat(sdd-gate): enforce gate before delivery`

### 阶段 4：前端支持冲突查看与修复入口
**目标**：用户能在 UI 查看冲突详情，并一键跳转到相关文件预览/编辑。

交付物：
- 冲突列表面板（或在日志区高亮摘要 + “查看详情”弹窗）

验收：
- 可以从 UI 快速定位冲突（API/表/字段/状态迁移）

提交：
- `feat(ui): show sdd gate conflicts`

## 6. 测试策略

- TypeScript 编译：`npx tsc --noEmit`
- 约束抽取：对示例 SDD 做解析单测（或 snapshot）
- Gate 校验：准备一份“故意冲突”的 OpenAPI/DDL 输入，验证能产出 conflicts

## 7. 风险与对策

- SDD 文本难解析：通过 prompt 强制输出“可提取结构块”降低风险
- 约束过严影响效率：阶段 2 先只做报告，再逐步升级为阻断
- 误报：冲突报告需提供“证据与路径”，可被用户复核

