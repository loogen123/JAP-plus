import type { FileId, FileRunStage } from "../pipeline/stateMachine.js";
import { clampText } from "../utils/stringUtils.js";

export type RagQueryContext = {
  fileId: FileId;
  stage: FileRunStage;
  requirement: string;
  approvedSummary: string;
};

export type BuiltRagQuery = {
  query: string;
  hints: string[];
};

const FILE_HINTS: Record<FileId, string[]> = {
  "01": ["领域对象", "业务术语", "核心约束"],
  "02": ["角色职责", "用例行为", "参与方"],
  "03": ["状态", "事件", "流转条件", "异常分支"],
  "04": ["模块边界", "职责划分", "依赖关系"],
  "05": ["数据结构", "字段约束", "关系映射"],
  "06": ["接口契约", "输入输出", "错误处理", "鉴权"],
  "07": ["总体设计", "跨模块约束", "已批准产物整合"],
};

const RAG_QUERY_REQUIREMENT_LIMIT = 2800;

export function buildRagQuery(ctx: RagQueryContext): BuiltRagQuery {
  const hints = FILE_HINTS[ctx.fileId] ?? [];
  const query = [
    `当前文件：${ctx.fileId}`,
    `当前阶段：${ctx.stage}`,
    `检索重点：${hints.join("、")}`,
    `原始需求：${clampText(ctx.requirement, RAG_QUERY_REQUIREMENT_LIMIT)}`,
    ctx.approvedSummary.trim() ? `已批准产物摘要：${ctx.approvedSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { query, hints };
}
