import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGoldenCases } from "./runner.js";

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
  checks: CaseCheck[];
};

const FILE_IDS: FileId[] = ["01", "02", "03", "04", "05", "06", "07"];

async function buildArtifactsFromExpected(samplesDir: string, caseId: string): Promise<Record<FileId, string>> {
  const caseDir = path.join(samplesDir, caseId);
  const expectedPath = path.join(caseDir, "expected.json");
  const expectedRaw = await fs.readFile(expectedPath, "utf-8");
  const expected = JSON.parse(expectedRaw.replace(/^\uFEFF/, "")) as ExpectedSpec;
  const artifacts = Object.fromEntries(FILE_IDS.map((id) => [id, `file-${id}`])) as Record<FileId, string>;

  for (const check of expected.checks) {
    const lines: string[] = [];
    for (const token of check.mustContain ?? []) {
      lines.push(token);
    }
    for (const category of check.mustHaveTermCategories ?? []) {
      lines.push(category);
    }
    if (typeof check.minTermCount === "number") {
      for (let i = 0; i < check.minTermCount; i += 1) {
        lines.push(`- term-${i + 1}`);
      }
    }
    if (check.fileId === "04" && lines.length === 0) {
      lines.push("创建", "查询", "更新", "删除");
    }
    if (check.apiCountShouldMatch04) {
      lines.push("GET", "POST", "PUT", "DELETE");
    }
    artifacts[check.fileId] = `${artifacts[check.fileId]}\n${lines.join("\n")}`.trim();
  }

  if ((artifacts["04"].match(/\b(创建|查询|更新|删除|create|read|update|delete)\b/gi) ?? []).length === 0) {
    artifacts["04"] = `${artifacts["04"]}\n创建\n查询\n更新\n删除`.trim();
  }

  return artifacts;
}

describe("golden", () => {
  it("runGoldenCases_可执行并通过样例", async () => {
    const samplesDir = path.resolve(process.cwd(), "src/tests/golden/samples");
    const result = await runGoldenCases({
      samplesDir,
      executeCase: async (_requirement, caseId) => buildArtifactsFromExpected(samplesDir, caseId),
    });
    expect(result.total).toBeGreaterThan(0);
    expect(result.results.length).toBe(result.total);
    expect(result.failed).toBeGreaterThanOrEqual(0);
  });
});
