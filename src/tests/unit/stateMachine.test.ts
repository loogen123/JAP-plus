import { describe, expect, it } from "vitest";
import {
  createInitialFileStates,
  deriveStageFromCurrentFile,
  ensureValidFileId,
  getFileRuntimeRecord,
  resolveCurrentFile,
  upsertFileState,
  withRunLock,
} from "../../services/taskService.js";

function makeMeta(): any {
  return {
    runId: "run-test",
    workflowMode: "filewise",
    stage: "MODELING",
    currentFile: "01",
    requirement: "req",
    questionnaire: null,
    userAnswers: {},
    llm: { baseUrl: "", apiKey: "", modelName: "" },
    workspacePath: "c:/tmp",
    status: "RUNNING",
    files: createInitialFileStates(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("stateMachine", () => {
  it("resolveCurrentFile_按顺序推进", () => {
    const meta = makeMeta();
    expect(resolveCurrentFile(meta.files)).toBe("01");
    upsertFileState(meta, "01", { status: "APPROVED" });
    expect(resolveCurrentFile(meta.files)).toBe("02");
    upsertFileState(meta, "02", { status: "APPROVED" });
    upsertFileState(meta, "03", { status: "APPROVED" });
    upsertFileState(meta, "04", { status: "APPROVED" });
    expect(resolveCurrentFile(meta.files)).toBe("05");
  });

  it("deriveStageFromCurrentFile_判断正确", () => {
    expect(deriveStageFromCurrentFile("01")).toBe("MODELING");
    expect(deriveStageFromCurrentFile("06")).toBe("DETAILING");
    expect(deriveStageFromCurrentFile(null)).toBe("DONE");
  });

  it("file07前置未满足_不可生成", () => {
    const meta = makeMeta();
    for (const id of ["01", "02", "03", "04", "05", "06"] as const) {
      upsertFileState(meta, id, { status: "PENDING" });
    }
    meta.currentFile = "07";
    const runtime = getFileRuntimeRecord(meta);
    expect(runtime.actions.canGenerateNext).toBe(false);
  });

  it("withRunLock_同run串行", async () => {
    let active = 0;
    let maxActive = 0;
    const run = async () => withRunLock("same-run", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
    await Promise.all([run(), run(), run()]);
    expect(maxActive).toBe(1);
  });

  it("resolveCurrentFile_全部通过返回null", () => {
    const meta = makeMeta();
    for (const file of meta.files) {
      file.status = "APPROVED";
    }
    expect(resolveCurrentFile(meta.files)).toBe(null);
  });

  it("getFileRuntimeRecord_pending可生成", () => {
    const meta = makeMeta();
    const runtime = getFileRuntimeRecord(meta);
    expect(runtime.actions.canGenerateNext).toBe(true);
    expect(runtime.actions.canApprove).toBe(false);
  });

  it("getFileRuntimeRecord_generated可审核和编辑", () => {
    const meta = makeMeta();
    upsertFileState(meta, "01", { status: "GENERATED" });
    const runtime = getFileRuntimeRecord(meta);
    expect(runtime.actions.canGenerateNext).toBe(false);
    expect(runtime.actions.canApprove).toBe(true);
    expect(runtime.actions.canReject).toBe(true);
    expect(runtime.actions.canSaveEdit).toBe(true);
  });

  it("getFileRuntimeRecord_generating不可再生", () => {
    const meta = makeMeta();
    upsertFileState(meta, "01", { status: "GENERATING" });
    const runtime = getFileRuntimeRecord(meta);
    expect(runtime.actions.canRegenerate).toBe(false);
  });

  it("createInitialFileStates_选择模块时强制包含01和07", () => {
    const states = createInitialFileStates(["03", "05"]);
    const ids = states.map((s) => s.fileId);
    expect(ids).toContain("01");
    expect(ids).toContain("07");
    expect(ids).toContain("03");
    expect(ids).toContain("05");
    expect(ids).not.toContain("02");
  });

  it("ensureValidFileId_非法值抛错", () => {
    expect(() => ensureValidFileId("01")).not.toThrow();
    expect(() => ensureValidFileId("99")).toThrow();
  });
});
