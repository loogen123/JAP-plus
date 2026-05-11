import type { GateCheckParams, GateCheckResult, GateRule } from "./types.js";

function extractBulletKeywords(input: string): string[] {
  return (input.match(/[-*]\s+(.+)/g) ?? [])
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .map((line) => line.split(/[：:]/)[0]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 200);
}

function runModuleSplitCheck(params: GateCheckParams): GateCheckResult {
  const from04 = params.artifacts["04"];
  const from05 = params.artifacts["05"];
  if (!from04 || !from05) {
    return { passed: true, severity: "warning", issues: [] };
  }
  const abilities = extractBulletKeywords(from04);
  const issues: GateCheckResult["issues"] = [];
  for (const ability of abilities) {
    if (!from05.includes(ability)) {
      issues.push({
        rule: "module-split",
        message: `04 能力在 05 缺少对应: ${ability}`,
        evidence: ability,
      });
    }
  }
  return {
    passed: issues.length === 0,
    severity: "warning",
    issues,
  };
}

export const moduleSplitCheck: GateRule = {
  id: "module-split",
  name: "模块拆分检查",
  description: "检查 04 能力与 05 交互映射是否完整",
  applyTo: ["05"],
  dependsOn: ["04"],
  check: runModuleSplitCheck,
};
