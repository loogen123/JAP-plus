import type { FileId } from "../../services/taskService.js";
import type { GateCheckParams, GateCheckResult, GateRule } from "./types.js";

type ScopePattern = {
  pattern: RegExp;
  message: string;
};

const SCOPE_BLACKLIST: Partial<Record<FileId, ScopePattern[]>> = {
  "01": [
    { pattern: /(API|endpoint|route|path)/gi, message: "01 不应定义 API 路径" },
    { pattern: /(数据库表|数据库|database|schema|table)/gi, message: "01 不应定义数据库结构" },
    { pattern: /(组件|component|目录结构)/gi, message: "01 不应定义实现架构" },
  ],
  "05": [
    { pattern: /```(?:tsx?|jsx?|python|go|java)/gi, message: "05 不应包含具体代码" },
    { pattern: /(REST|endpoint|route|path)/gi, message: "05 不应写死 REST 路径" },
  ],
  "07": [
    { pattern: /(任务清单|task list|checklist|to-?do|checkbox)/gi, message: "07 不是任务清单，应为约束总览" },
  ],
};

function runScopeCheck(params: GateCheckParams): GateCheckResult {
  const blacklist = SCOPE_BLACKLIST[params.fileId] ?? [];
  const issues = blacklist
    .filter((item) => item.pattern.test(params.content))
    .map((item) => ({
      rule: "scope-check",
      message: item.message,
      evidence: String(item.pattern),
    }));
  return {
    passed: issues.length === 0,
    severity: "error",
    issues,
  };
}

export const scopeCheck: GateRule = {
  id: "scope-check",
  name: "职责越界检查",
  description: "检查各文件职责边界是否被破坏",
  applyTo: null,
  check: runScopeCheck,
};
