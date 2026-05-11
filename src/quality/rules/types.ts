import type { FileId } from "../../services/taskService.js";

export type GateIssue = {
  rule: string;
  message: string;
  evidence: string;
};

export type GateCheckResult = {
  passed: boolean;
  severity: "error" | "warning";
  issues: GateIssue[];
};

export type GateCheckParams = {
  fileId: FileId;
  content: string;
  artifacts: Record<string, string>;
};

export type GateRule = {
  id: string;
  name: string;
  description: string;
  applyTo: FileId[] | null;
  dependsOn?: FileId[];
  check: (params: GateCheckParams) => GateCheckResult;
};
