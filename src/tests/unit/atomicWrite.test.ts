import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFilewiseRun, readMeta, saveMeta, toRunFilePath, writeFileBody } from "../../services/taskService.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("atomicWrite", () => {
  it("writeFileBody_tmpRename_内容正确", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "jap-atomic-"));
    tempDirs.push(workspace);
    const meta = await createFilewiseRun({
      requirement: "req",
      llm: {},
      workspace,
      questionnaire: null,
      userAnswers: {},
    });
    await writeFileBody(workspace, meta.runId, "01", "hello");
    const filePath = toRunFilePath(workspace, meta.runId, "01");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("hello");
  });

  it("saveMeta_脱敏apiKey", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "jap-meta-"));
    tempDirs.push(workspace);
    const meta = await createFilewiseRun({
      requirement: "req",
      llm: { apiKey: "secret", baseUrl: "x", modelName: "y" },
      workspace,
      questionnaire: null,
      userAnswers: {},
    });
    meta.llm.apiKey = "changed";
    await saveMeta(meta);
    const saved = await readMeta(workspace, meta.runId);
    expect(saved.llm.apiKey).toBe("***");
  });
});
