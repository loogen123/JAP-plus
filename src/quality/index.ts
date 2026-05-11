import type { FileId } from "../services/taskService.js";
import { crossFileConflict } from "./rules/crossFileConflict.js";
import { moduleSplitCheck } from "./rules/moduleSplitCheck.js";
import { namingConsistency } from "./rules/namingConsistency.js";
import { routeBoundary } from "./rules/routeBoundary.js";
import { scopeCheck } from "./rules/scopeCheck.js";
import type { GateCheckParams, GateRule } from "./rules/types.js";

export type GateReport = {
  fileId: FileId;
  passed: boolean;
  checks: { ruleId: string; ruleName: string; passed: boolean; severity: "error" | "warning"; issues: { rule: string; message: string; evidence: string }[] }[];
  totalErrors: number;
  totalWarnings: number;
  durationMs: number;
};

export class GateBlockedError extends Error {
  report: GateReport;

  constructor(report: GateReport) {
    super(`质量门禁未通过: ${report.fileId}`);
    this.name = "GateBlockedError";
    this.report = report;
  }
}

const ALL_RULES: GateRule[] = [
  scopeCheck,
  namingConsistency,
  moduleSplitCheck,
  routeBoundary,
  crossFileConflict,
];

export async function runQualityGate(fileId: FileId, content: string, artifacts: Record<string, string>): Promise<GateReport> {
  const start = Date.now();
  const applicableRules = ALL_RULES.filter((r) => r.applyTo === null || r.applyTo.includes(fileId));
  const checks = applicableRules.map((rule) => {
    const params: GateCheckParams = { fileId, content, artifacts };
    const result = rule.check(params);
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      passed: result.passed,
      severity: result.severity,
      issues: result.issues,
    };
  });
  const totalErrors = checks.reduce((n, check) => n + (check.severity === "error" ? check.issues.length : 0), 0);
  const totalWarnings = checks.reduce((n, check) => n + (check.severity === "warning" ? check.issues.length : 0), 0);
  return {
    fileId,
    passed: totalErrors === 0,
    checks,
    totalErrors,
    totalWarnings,
    durationMs: Date.now() - start,
  };
}
