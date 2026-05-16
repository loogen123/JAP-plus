import { beforeEach, describe, expect, it, vi } from "vitest";

const taskServiceMocks = vi.hoisted(() => ({
  resolveWorkspacePath: vi.fn(() => "D:/demo"),
  listHistoryRecords: vi.fn(),
  resolveHistoryRecord: vi.fn(),
  readPreview: vi.fn(),
  normalizeQuestionnaire: vi.fn((value: unknown) => value),
  isStringOrStringArrayRecord: vi.fn(
    (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
  ),
  createOrResumeFilewiseRun: vi.fn(),
  filewiseGenerateCurrent: vi.fn(),
  filewiseGeneratePendingBaseFiles: vi.fn(),
  listSddSourceRuns: vi.fn(),
}));

const pipelineMocks = vi.hoisted(() => ({
  withRunLock: vi.fn(async (_runId: string, fn: () => Promise<void>) => {
    await fn();
  }),
  getFileRuntimeRecord: vi.fn(),
  toFileStatusResponse: vi.fn((meta: { runId: string; ragKbIds?: string[] }, workspacePath: string) => ({
    runId: meta.runId,
    ragKbIds: meta.ragKbIds,
    workspacePath,
  })),
  ensureValidFileId: vi.fn(),
  upsertFileState: vi.fn(),
  resolveCurrentFile: vi.fn(),
  deriveStageFromCurrentFile: vi.fn(),
}));

const metaStoreMocks = vi.hoisted(() => ({
  readMeta: vi.fn(),
  saveMeta: vi.fn(),
}));

const ragMocks = vi.hoisted(() => ({
  getKnowledgeBase: vi.fn(),
}));

vi.mock("../../services/taskService.js", () => taskServiceMocks);
vi.mock("../../pipeline/stateMachine.js", () => pipelineMocks);
vi.mock("../../persistence/metaStore.js", () => metaStoreMocks);
vi.mock("../../persistence/eventLog.js", () => ({
  getRunLastEventAt: vi.fn(),
  readRunEventsTail: vi.fn(),
}));
vi.mock("../../persistence/artifactStore.js", () => ({
  readFileBody: vi.fn(),
  writeFileBody: vi.fn(),
}));
vi.mock("../../runtime/workflowEvents.js", () => ({
  emitTaskScopedEvent: vi.fn(),
}));
vi.mock("../../constants/domainConstants.js", () => ({
  ARTIFACT_FILES: {
    sdd07: "07.md",
  },
}));
vi.mock("../../utils/logger.js", () => ({
  appendRunEvent: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../rag/index.js", () => ragMocks);

import { TaskController } from "../../controllers/taskController.js";

function createResponse() {
  const response: Record<string, unknown> = {
    statusCode: 200,
  };
  response.json = vi.fn((payload: unknown) => {
    response.body = payload;
    return response;
  });
  response.status = vi.fn((statusCode: number) => {
    response.statusCode = statusCode;
    return response;
  });
  return response as {
    statusCode: number;
    body?: unknown;
    json: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
}

describe("task rag binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskServiceMocks.resolveWorkspacePath.mockReturnValue("D:/demo");
    taskServiceMocks.normalizeQuestionnaire.mockImplementation((value: unknown) => value);
    taskServiceMocks.isStringOrStringArrayRecord.mockImplementation(
      (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    );
    pipelineMocks.withRunLock.mockImplementation(async (_runId: string, fn: () => Promise<void>) => {
      await fn();
    });
    pipelineMocks.toFileStatusResponse.mockImplementation(
      (meta: { runId: string; ragKbIds?: string[] }, workspacePath: string) => ({
        runId: meta.runId,
        ragKbIds: meta.ragKbIds,
        workspacePath,
      }),
    );
    ragMocks.getKnowledgeBase.mockResolvedValue({ id: "kb", name: "KB" });
  });

  it("创建任务时保存多个 ragKbIds", async () => {
    taskServiceMocks.createOrResumeFilewiseRun.mockResolvedValue({
      meta: {
        runId: "run-1",
        stage: "MODELING",
        currentFile: "01",
      },
      resumed: false,
    });
    const controller = new TaskController();
    const req = {
      body: {
        requirement: "做一个带审批流的需求设计系统",
        ragKbIds: ["kb-a", " kb-b ", "kb-a"],
        llm: {},
        workspace: { path: "D:/demo" },
      },
    };
    const res = createResponse();

    await controller.startFilewiseTask(req as any, res as any);

    expect(res.status).not.toHaveBeenCalled();
    expect(ragMocks.getKnowledgeBase).toHaveBeenNthCalledWith(1, "kb-a");
    expect(ragMocks.getKnowledgeBase).toHaveBeenNthCalledWith(2, "kb-b");
    expect(taskServiceMocks.createOrResumeFilewiseRun).toHaveBeenCalledWith(
      expect.objectContaining({
        ragKbIds: ["kb-a", "kb-b"],
      }),
    );
    expect(res.json).toHaveBeenCalledWith({
      runId: "run-1",
      stage: "MODELING",
      currentFile: "01",
      resumed: false,
    });
  });

  it("创建任务时 ragKbIds 不是数组会报 400", async () => {
    const controller = new TaskController();
    const req = {
      body: {
        requirement: "需求",
        ragKbIds: "kb-a",
        llm: {},
        workspace: { path: "D:/demo" },
      },
    };
    const res = createResponse();

    await controller.startFilewiseTask(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "ragKbIds must be an array" });
    expect(taskServiceMocks.createOrResumeFilewiseRun).not.toHaveBeenCalled();
  });

  it("创建任务时旧字段 ragKbId 不再被接受", async () => {
    const controller = new TaskController();
    const req = {
      body: {
        requirement: "需求",
        ragKbId: "kb-a",
        llm: {},
        workspace: { path: "D:/demo" },
      },
    };
    const res = createResponse();

    await controller.startFilewiseTask(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "ragKbIds must be an array" });
    expect(taskServiceMocks.createOrResumeFilewiseRun).not.toHaveBeenCalled();
  });

  it("创建任务时非法 ragKbId 会报 400", async () => {
    ragMocks.getKnowledgeBase.mockImplementation(async (kbId: string) =>
      kbId === "kb-b" ? null : { id: kbId, name: kbId },
    );
    const controller = new TaskController();
    const req = {
      body: {
        requirement: "需求",
        ragKbIds: ["kb-a", "kb-b"],
        llm: {},
        workspace: { path: "D:/demo" },
      },
    };
    const res = createResponse();

    await controller.startFilewiseTask(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "invalid ragKbId: kb-b" });
    expect(taskServiceMocks.createOrResumeFilewiseRun).not.toHaveBeenCalled();
  });

  it("绑定任务时整组覆盖 ragKbIds", async () => {
    const meta = {
      runId: "run-1",
      ragKbIds: ["kb-a", "kb-b"],
    };
    metaStoreMocks.readMeta.mockResolvedValue(meta);
    const controller = new TaskController();
    const req = {
      params: { runId: "run-1" },
      body: {
        ragKbIds: ["kb-c", " kb-d ", "kb-c"],
        workspace: { path: "D:/demo" },
      },
      query: {},
    };
    const res = createResponse();

    await controller.bindRagKnowledgeBase(req as any, res as any);

    expect(res.status).not.toHaveBeenCalled();
    expect(metaStoreMocks.saveMeta).toHaveBeenCalledWith({
      runId: "run-1",
      ragKbIds: ["kb-c", "kb-d"],
    });
    expect(res.json).toHaveBeenCalledWith({
      runId: "run-1",
      ragKbIds: ["kb-c", "kb-d"],
      workspacePath: "D:/demo",
    });
  });

  it("绑定任务时空数组会清空 ragKbIds", async () => {
    const meta = {
      runId: "run-1",
      ragKbIds: ["kb-a"],
    };
    metaStoreMocks.readMeta.mockResolvedValue(meta);
    const controller = new TaskController();
    const req = {
      params: { runId: "run-1" },
      body: {
        ragKbIds: [],
        workspace: { path: "D:/demo" },
      },
      query: {},
    };
    const res = createResponse();

    await controller.bindRagKnowledgeBase(req as any, res as any);

    expect(metaStoreMocks.saveMeta).toHaveBeenCalledWith({
      runId: "run-1",
      ragKbIds: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({
      runId: "run-1",
      ragKbIds: undefined,
      workspacePath: "D:/demo",
    });
  });
});
