import type { GateCheckParams, GateCheckResult, GateRule } from "./types.js";

function toSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function toCamel(input: string): string {
  return input.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function extractTerms(dict: string): string[] {
  const out = new Set<string>();
  const codeLike = dict.match(/\b[a-z][a-z0-9_]{2,}\b/g) ?? [];
  for (const token of codeLike) {
    out.add(token);
  }
  return [...out].slice(0, 500);
}

function termVariants(term: string): string[] {
  const variants = new Set<string>([term, toSnake(term), toCamel(toSnake(term))]);
  return [...variants];
}

function runNamingConsistency(params: GateCheckParams): GateCheckResult {
  const dict = params.artifacts["02"];
  if (!dict) {
    return { passed: true, severity: "warning", issues: [] };
  }
  const issues: GateCheckResult["issues"] = [];
  const targets: Array<"03" | "04" | "06"> = ["03", "04", "06"];
  const terms = extractTerms(dict);
  for (const targetId of targets) {
    const target = params.artifacts[targetId];
    if (!target) {
      continue;
    }
    for (const term of terms) {
      const variants = termVariants(term).filter((v) => new RegExp(`\\b${v}\\b`, "g").test(target));
      if (variants.length > 1) {
        issues.push({
          rule: "naming-consistency",
          message: `术语 ${term} 在文件 ${targetId} 存在变体: ${variants.join(", ")}`,
          evidence: `02:${term}`,
        });
      }
    }
  }
  return {
    passed: issues.length === 0,
    severity: "warning",
    issues,
  };
}

export const namingConsistency: GateRule = {
  id: "naming-consistency",
  name: "命名一致性检查",
  description: "检查领域词典与其他产物术语是否一致",
  applyTo: ["02", "03", "04", "06"],
  dependsOn: ["02"],
  check: runNamingConsistency,
};
