import type { GateCheckParams, GateCheckResult, GateRule } from "./types.js";

function runCrossFileConflict(params: GateCheckParams): GateCheckResult {
  const from03 = params.artifacts["03"] ?? "";
  const from04 = params.artifacts["04"] ?? "";
  const from06 = params.artifacts["06"] ?? "";
  const from02 = params.artifacts["02"] ?? "";
  const issues: GateCheckResult["issues"] = [];

  const hasDeletedState = /(已删除|deleted)/i.test(from03);
  const hasDeleteAbility = /(删除|delete)/i.test(from04);
  if (hasDeletedState && !hasDeleteAbility) {
    issues.push({
      rule: "cross-file-conflict",
      message: "03 包含已删除状态，但 04 缺少删除能力",
      evidence: "03:deleted -> 04:delete missing",
    });
  }

  const paramsIn06 = [...new Set((from06.match(/\b[a-z][a-z0-9_]{2,}\b/g) ?? []).slice(0, 400))];
  const dictTerms = new Set(from02.match(/\b[a-z][a-z0-9_]{2,}\b/g) ?? []);
  for (const key of paramsIn06) {
    if (!dictTerms.has(key)) {
      issues.push({
        rule: "cross-file-conflict",
        message: `06 参数在 02 未定义: ${key}`,
        evidence: `missing-in-02:${key}`,
      });
    }
  }

  return {
    passed: issues.length === 0,
    severity: "warning",
    issues,
  };
}

export const crossFileConflict: GateRule = {
  id: "cross-file-conflict",
  name: "跨文件冲突检查",
  description: "检查 03/04/06 与 02 之间的约束冲突",
  applyTo: ["03", "04", "06"],
  dependsOn: ["02", "03", "04", "06"],
  check: runCrossFileConflict,
};
