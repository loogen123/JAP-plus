import fs from "node:fs/promises";
import path from "node:path";

type FileId = "01" | "02" | "03" | "04" | "05" | "06" | "07";

type CaseCheck = {
  fileId: FileId;
  mustContain?: string[];
  mustNotContain?: string[];
  minTermCount?: number;
  mustHaveTermCategories?: string[];
  apiCountShouldMatch04?: boolean;
};

type ExpectedSpec = {
  caseId: string;
  description: string;
  checks: CaseCheck[];
};

type GoldenManifest = {
  cases: string[];
};

export type GoldenCaseResult = {
  caseId: string;
  passed: boolean;
  issues: string[];
};

export type GoldenRunResult = {
  passed: boolean;
  total: number;
  failed: number;
  results: GoldenCaseResult[];
};

export async function runGoldenCases(params: {
  samplesDir: string;
  executeCase: (requirement: string, caseId: string) => Promise<Record<FileId, string>>;
}): Promise<GoldenRunResult> {
  const manifestPath = path.join(params.samplesDir, "manifest.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestRaw.replace(/^\uFEFF/, "")) as GoldenManifest;
  const results: GoldenCaseResult[] = [];

  for (const caseId of manifest.cases) {
    const caseDir = path.join(params.samplesDir, caseId);
    const requirement = await fs.readFile(path.join(caseDir, "requirement.md"), "utf-8");
    const expectedRaw = await fs.readFile(path.join(caseDir, "expected.json"), "utf-8");
    const expected = JSON.parse(expectedRaw.replace(/^\uFEFF/, "")) as ExpectedSpec;
    const artifacts = await params.executeCase(requirement, caseId);
    results.push(evaluateCase(expected, artifacts));
  }

  const failed = results.filter((item) => !item.passed).length;
  return {
    passed: failed === 0,
    total: results.length,
    failed,
    results,
  };
}

function evaluateCase(expected: ExpectedSpec, artifacts: Record<FileId, string>): GoldenCaseResult {
  const issues: string[] = [];
  for (const check of expected.checks) {
    const content = artifacts[check.fileId] ?? "";
    for (const token of check.mustContain ?? []) {
      if (!content.includes(token)) {
        issues.push(`${check.fileId} missing "${token}"`);
      }
    }
    for (const token of check.mustNotContain ?? []) {
      if (content.includes(token)) {
        issues.push(`${check.fileId} contains forbidden "${token}"`);
      }
    }
    if (typeof check.minTermCount === "number") {
      const termCount = (content.match(/[-*]\s+/g) ?? []).length;
      if (termCount < check.minTermCount) {
        issues.push(`${check.fileId} termCount ${termCount} < ${check.minTermCount}`);
      }
    }
    for (const category of check.mustHaveTermCategories ?? []) {
      if (!content.includes(category)) {
        issues.push(`${check.fileId} missing category "${category}"`);
      }
    }
    if (check.apiCountShouldMatch04) {
      const base = artifacts["04"] ?? "";
      const baseCount = (base.match(/\b(创建|查询|更新|删除|create|read|update|delete)\b/gi) ?? []).length;
      const apiCount = (content.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).length;
      if (Math.abs(baseCount - apiCount) > 2) {
        issues.push(`${check.fileId} apiCount mismatch with 04`);
      }
    }
  }
  return {
    caseId: expected.caseId,
    passed: issues.length === 0,
    issues,
  };
}
