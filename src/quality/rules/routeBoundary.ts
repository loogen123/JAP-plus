import type { GateCheckParams, GateCheckResult, GateRule } from "./types.js";

function extractRoutes(input: string): Set<string> {
  const out = new Set<string>();
  const matches = input.match(/\/[a-zA-Z0-9/_-]*/g) ?? [];
  for (const route of matches) {
    if (route.length > 1) {
      out.add(route.toLowerCase());
    }
  }
  return out;
}

function runRouteBoundary(params: GateCheckParams): GateCheckResult {
  const from04 = params.artifacts["04"];
  const from06 = params.artifacts["06"];
  if (!from04 || !from06) {
    return { passed: true, severity: "warning", issues: [] };
  }
  const r04 = extractRoutes(from04);
  const r06 = extractRoutes(from06);
  const issues: GateCheckResult["issues"] = [];
  for (const route of r04) {
    if (!r06.has(route)) {
      issues.push({
        rule: "route-boundary",
        message: `04 中路径未在 06 出现: ${route}`,
        evidence: route,
      });
    }
  }
  return {
    passed: issues.length === 0,
    severity: "warning",
    issues,
  };
}

export const routeBoundary: GateRule = {
  id: "route-boundary",
  name: "路由边界检查",
  description: "检查 04 与 06 的路径边界一致性",
  applyTo: ["06"],
  dependsOn: ["04"],
  check: runRouteBoundary,
};
