import type { GateReport } from "./index.js";

export function formatGateSummary(report: GateReport): string {
  if (report.passed) {
    return "通过";
  }
  const failed = report.checks.filter((item) => !item.passed).map((item) => item.ruleName);
  return `未通过: ${failed.join(", ")}`;
}
