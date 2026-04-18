import type { Request, Response } from "express";
import {
  withRunLock,
  resolveWorkspacePath,
  listHistoryRecords,
  resolveHistoryRecord,
  readPreview,
  normalizeQuestionnaire,
  isStringOrStringArrayRecord,
  createFilewiseRun,
  readMeta,
  getFileRuntimeRecord,
  readFileBody,
  toFileStatusResponse,
  filewiseGenerateCurrent,
  ensureValidFileId,
  upsertFileState,
  resolveCurrentFile,
  deriveStageFromCurrentFile,
  saveMeta,
  appendEventLog,
  writeFileBody,
  readSddConstraints,
  readSddGateValidation,
  listSddSourceRuns,
  readRunEventsTail,
  getRunLastEventAt,
} from "../services/taskService.js";
import { emitTaskScopedEvent } from "../runtime/workflowEvents.js";

export class TaskController {
  private inferSddErrorCode(message: string): string {
    const text = message.toLowerCase();
    if (text.includes("connection error") || text.includes("econn") || text.includes("socket hang up")) {
      return "SDD_LLM_CONNECTION_ERROR";
    }
    if (text.includes("timeout") || text.includes("timed out")) {
      return "SDD_LLM_TIMEOUT";
    }
    if (text.includes("unauthorized") || text.includes("invalid api key") || text.includes("401")) {
      return "SDD_LLM_AUTH_ERROR";
    }
    if (text.includes("rate limit") || text.includes("429")) {
      return "SDD_LLM_RATE_LIMIT";
    }
    return "SDD_GENERATION_FAILED";
  }

  private async buildSddErrorPayload(
    workspacePath: string,
    runId: string,
    stage: string,
    message: string,
    errorCode?: string,
  ) {
    const lastEventAt = await getRunLastEventAt(workspacePath, runId);
    return {
      message,
      errorCode: errorCode || this.inferSddErrorCode(message),
      stage,
      lastEventAt,
    };
  }

  async getHistoryRequirements(req: Request, res: Response) {
    const queryWorkspacePath = typeof req.query.workspacePath === "string" ? req.query.workspacePath : "";
    const workspacePath = resolveWorkspacePath(queryWorkspacePath);
    try {
      const records = await listHistoryRecords(workspacePath);
      res.json({
        workspacePath,
        items: records.map((record) => ({
          id: record.id,
          type: record.type,
          createdAt: record.createdAt,
          paths: record.paths,
          summary: record.summary,
          requirementAvailable: record.requirementAvailable,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async getHistoryRequirementById(req: Request, res: Response) {
    const id = String(req.params.id ?? "").trim();
    const queryWorkspacePath = typeof req.query.workspacePath === "string" ? req.query.workspacePath : "";
    const workspacePath = resolveWorkspacePath(queryWorkspacePath);
    const queryType = String(req.query.type ?? "").trim().toLowerCase();
    const typeHint = queryType === "task" || queryType === "draft" ? queryType : undefined;

    if (!id) {
      res.status(400).json({ message: "id is required" });
      return;
    }

    try {
      const record = await resolveHistoryRecord(workspacePath, id, typeHint);
      if (!record) {
        res.status(404).json({ message: "history record not found" });
        return;
      }

      const rawPreview = await readPreview(record.absolutePaths.raw, 30000);
      const normalizedPreview = await readPreview(record.absolutePaths.normalized, 30000);
      const finalPreview = await readPreview(record.absolutePaths.final, 30000);
      const requirementSource =
        finalPreview.exists && finalPreview.content.trim()
          ? "final"
          : normalizedPreview.exists && normalizedPreview.content.trim()
            ? "normalized"
            : rawPreview.exists && rawPreview.content.trim()
              ? "raw"
              : null;

      res.json({
        id: record.id,
        type: record.type,
        createdAt: record.createdAt,
        paths: record.paths,
        summary: record.summary,
        requirement: {
          available: Boolean(requirementSource),
          source: requirementSource,
        },
        previews: {
          raw: {
            ...rawPreview,
            path: record.paths.raw,
          },
          normalized: {
            ...normalizedPreview,
            path: record.paths.normalized,
          },
          final: {
            ...finalPreview,
            path: record.paths.final,
          },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async startFilewiseTask(req: Request, res: Response) {
    const requirement = String(req.body?.requirement ?? "").trim();
    const llm = req.body?.llm ?? {};
    const workspace = req.body?.workspace ?? {};
    const questionnaire = normalizeQuestionnaire(req.body?.questionnaire ?? null);
    const userAnswers = isStringOrStringArrayRecord(req.body?.userAnswers)
      ? req.body.userAnswers
      : {};
    if (!requirement) {
      res.status(400).json({ message: "requirement is required" });
      return;
    }
    try {
      const meta = await createFilewiseRun({
        requirement,
        llm,
        workspace,
        questionnaire,
        userAnswers,
      });
      res.json({
        runId: meta.runId,
        stage: meta.stage,
        currentFile: meta.currentFile,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async getFilewiseTask(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.query.workspace ?? req.query.workspacePath ?? req.body?.workspace);
    const includeContent = req.query.includeContent === "true";
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      const meta = await readMeta(workspacePath, runId);
      const runtime = getFileRuntimeRecord(meta);
      const currentBody = (includeContent && runtime.currentFile)
        ? await readFileBody(workspacePath, runId, runtime.currentFile)
        : undefined;
      const sddConstraints = await readSddConstraints(workspacePath, runId);
      const sddValidation = await readSddGateValidation(workspacePath, runId);
      const responseObj: any = {
        ...toFileStatusResponse(meta, workspacePath),
        sdd: {
          constraints: sddConstraints,
          validation: sddValidation,
        },
      };
      if (currentBody !== undefined) {
        responseObj.currentFileContent = currentBody;
      }
      res.json(responseObj);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ message });
    }
  }

  async getFilewiseFileContent(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const fileId = String(req.params.fileId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.query.workspace ?? req.query.workspacePath ?? req.body?.workspace);
    if (!runId || !fileId) {
      res.status(400).json({ message: "runId and fileId are required" });
      return;
    }
    try {
      const content = await readFileBody(workspacePath, runId, fileId as any);
      res.json({ content });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ message });
    }
  }

  async getFilewiseEvents(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.query.workspace ?? req.query.workspacePath ?? req.body?.workspace);
    const tailRaw = Number(req.query.tail ?? 200);
    const tail = Number.isFinite(tailRaw) ? Math.max(1, Math.min(1000, Math.floor(tailRaw))) : 200;
    const cursor = Number(req.query.cursor) || 0;
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      const { events, nextCursor } = await readRunEventsTail(workspacePath, runId, tail, cursor);
      const lastEventAt = events.length > 0 ? String(events[events.length - 1]?.at ?? "") : null;
      res.json({ runId, tail, cursor, nextCursor, lastEventAt, events });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async generateNext(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        const runtime = getFileRuntimeRecord(meta);
        if (!runtime.actions.canGenerateNext || !meta.currentFile) {
          res.status(409).json({ message: "no file is ready for generation", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        await filewiseGenerateCurrent(meta);
      });
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async generateBaseNext(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        const runtime = getFileRuntimeRecord(meta);
        if (!runtime.actions.canGenerateNext || !meta.currentFile) {
          res.status(409).json({ message: "no file is ready for generation", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        if (meta.currentFile === "08") {
          res.status(409).json({ message: "base generation only supports file 01-07", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        await filewiseGenerateCurrent(meta);
      });
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async generateSdd(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      const sourceRunId = String(req.body?.sourceRunId ?? "").trim();
      const currentMeta = await readMeta(workspacePath, runId);
      const targetRunId = sourceRunId || runId;
      await withRunLock(targetRunId, async () => {
        let meta = await readMeta(workspacePath, targetRunId);
        if (sourceRunId) {
          const baseReady = ["01", "02", "03", "04", "05", "06", "07"].every((fileId) => {
            const state = meta.files.find((item) => item.fileId === fileId);
            return state?.status === "APPROVED";
          });
          if (!baseReady) {
            res.status(409).json({ message: "历史任务未完成01-07审核通过，不能用于SDD生成" });
            return;
          }

          // 兼容老版本的历史流程：如果历史流程里没有 08 文件，自动补齐
          if (!meta.files.find(f => f.fileId === "08")) {
            meta.files.push({
              fileId: "08",
              artifactName: "08_SDD_软件设计说明书.md",
              status: "PENDING",
              retries: 0,
              lastError: null,
              usedMcp: false,
              toolName: null,
              fallbackReason: null,
              updatedAt: new Date().toISOString(),
            });
          }

          // 关键修复：强制将任务指针移动到 08，否则前端审批时会报 "only current file can be approved"
          meta.currentFile = "08";
          meta.stage = "DETAILING";

          meta.llm = currentMeta.llm;
          upsertFileState(meta, "08", { status: "PENDING", lastError: null });
          await saveMeta(meta);
          meta = await readMeta(workspacePath, targetRunId);
        }
        const runtime = getFileRuntimeRecord(meta);
        if (!meta.currentFile) {
          res.status(409).json({ message: "no current file to generate", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        if (meta.currentFile !== "08") {
          res.status(409).json({ message: "sdd generation only supports file 08", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        if (!runtime.actions.canGenerateNext) {
          res.status(409).json({ message: "file 08 is not ready for generation", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        await filewiseGenerateCurrent(meta);
        let refreshed = await readMeta(workspacePath, targetRunId);
        const sddFile = refreshed.files.find((item) => item.fileId === "08");
        if (sddFile && (sddFile.status === "GENERATED" || sddFile.status === "REVIEWING")) {
          upsertFileState(refreshed, "08", { status: "APPROVED", lastError: null });
          
          // 修正：推进 currentFile 和更新任务状态，避免前端死循环弹窗
          const nextFile = resolveCurrentFile(refreshed.files);
          refreshed.currentFile = nextFile;
          refreshed.stage = deriveStageFromCurrentFile(nextFile);
          refreshed.status = nextFile ? "RUNNING" : "DONE";

          await saveMeta(refreshed);

          // 推送实时 WebSocket 事件，保持前端状态机同步
          emitTaskScopedEvent(targetRunId, "FILE_APPROVED", { runId: targetRunId, fileId: "08", status: "APPROVED" });
          emitTaskScopedEvent(targetRunId, "RUN_POINTER_MOVED", { runId: targetRunId, stage: refreshed.stage, currentFile: refreshed.currentFile });
          if (refreshed.status === "DONE") {
            emitTaskScopedEvent(targetRunId, "TASK_FINISHED", { runId: targetRunId, status: "DONE" });
          }

          await appendEventLog(workspacePath, targetRunId, "FILE_APPROVED", { fileId: "08", auto: true });
        }
      });
      const finalMeta = await readMeta(workspacePath, targetRunId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = await this.buildSddErrorPayload(workspacePath, runId, "DETAILING", message);
      res.status(500).json(payload);
    }
  }

  async listSddSources(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.query.workspace ?? req.query.workspacePath ?? req.body?.workspace);
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      const items = await listSddSourceRuns(workspacePath, runId);
      res.json({ runId, workspacePath, items });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async listGlobalSddSources(req: Request, res: Response) {
    const workspacePath = resolveWorkspacePath(req.query.workspace ?? req.query.workspacePath ?? req.body?.workspace);
    try {
      const items = await listSddSourceRuns(workspacePath, "");
      res.json({ workspacePath, items });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async generateSddFromSource(req: Request, res: Response) {
    const sourceRunId = String(req.body?.sourceRunId ?? "").trim();
    const llm = req.body?.llm ?? {};
    const workspace = req.body?.workspace ?? {};
    const workspacePath = resolveWorkspacePath(workspace);
    if (!sourceRunId) {
      res.status(400).json({
        message: "sourceRunId is required",
        errorCode: "SDD_SOURCE_RUN_ID_REQUIRED",
        stage: "DETAILING",
        lastEventAt: null,
      });
      return;
    }
    try {
      await withRunLock(sourceRunId, async () => {
        const sourceMeta = await readMeta(workspacePath, sourceRunId);
        const baseReady = ["01", "02", "03", "04", "05", "06", "07"].every((fileId) => {
          const state = sourceMeta.files.find((item) => item.fileId === fileId);
          return state?.status === "APPROVED";
        });
        if (!baseReady) {
          const payload = await this.buildSddErrorPayload(
            workspacePath,
            sourceRunId,
            "DETAILING",
            "历史任务未完成01-07审核通过，不能用于SDD生成",
            "SDD_SOURCE_NOT_READY",
          );
          res.status(409).json(payload);
          return;
        }
        const llmRaw = llm && typeof llm === "object" ? (llm as Record<string, unknown>) : {};
        if (typeof llmRaw.baseUrl === "string" && llmRaw.baseUrl.trim()) {
          sourceMeta.llm.baseUrl = llmRaw.baseUrl.trim();
        }
        if (typeof llmRaw.apiKey === "string" && llmRaw.apiKey.trim()) {
          sourceMeta.llm.apiKey = llmRaw.apiKey.trim();
        }
        if (typeof llmRaw.modelName === "string" && llmRaw.modelName.trim()) {
          sourceMeta.llm.modelName = llmRaw.modelName.trim();
        }
        // 兼容老版本的历史流程：如果历史流程里没有 08 文件，自动补齐
        if (!sourceMeta.files.find(f => f.fileId === "08")) {
          sourceMeta.files.push({
            fileId: "08",
            artifactName: "08_SDD_软件设计说明书.md",
            status: "PENDING",
            retries: 0,
            lastError: null,
            usedMcp: false,
            toolName: null,
            fallbackReason: null,
            updatedAt: new Date().toISOString(),
          });
        }

        // 关键修复：强制将任务指针移动到 08，否则前端审批时会报 "only current file can be approved"
        sourceMeta.currentFile = "08";
        sourceMeta.stage = "DETAILING";
        
        upsertFileState(sourceMeta, "08", { status: "PENDING", lastError: null });
        await saveMeta(sourceMeta);
        const ready = await readMeta(workspacePath, sourceRunId);
        await filewiseGenerateCurrent(ready);
        let refreshed = await readMeta(workspacePath, sourceRunId);
        const sddFile = refreshed.files.find((item) => item.fileId === "08");
        if (sddFile && (sddFile.status === "GENERATED" || sddFile.status === "REVIEWING")) {
          upsertFileState(refreshed, "08", { status: "APPROVED", lastError: null });
          
          // 修正：推进 currentFile 和更新任务状态，避免前端死循环弹窗
          const nextFile = resolveCurrentFile(refreshed.files);
          refreshed.currentFile = nextFile;
          refreshed.stage = deriveStageFromCurrentFile(nextFile);
          refreshed.status = nextFile ? "RUNNING" : "DONE";

          await saveMeta(refreshed);

          // 推送实时 WebSocket 事件，保持前端状态机同步
          emitTaskScopedEvent(sourceRunId, "FILE_APPROVED", { runId: sourceRunId, fileId: "08", status: "APPROVED" });
          emitTaskScopedEvent(sourceRunId, "RUN_POINTER_MOVED", { runId: sourceRunId, stage: refreshed.stage, currentFile: refreshed.currentFile });
          if (refreshed.status === "DONE") {
            emitTaskScopedEvent(sourceRunId, "TASK_FINISHED", { runId: sourceRunId, status: "DONE" });
          }

          await appendEventLog(workspacePath, sourceRunId, "FILE_APPROVED", { fileId: "08", auto: true });
          await appendEventLog(workspacePath, sourceRunId, "LOG_ADDED", { logType: "INFO", title: "系统", summary: "08 文件已生成并通过自动审核" });
        }
      });
      const finalRefreshed = await readMeta(workspacePath, sourceRunId);
      const lastEventAt = await getRunLastEventAt(workspacePath, sourceRunId);
      res.json({
        ...toFileStatusResponse(finalRefreshed, workspacePath),
        errorCode: null,
        stage: finalRefreshed.stage,
        lastEventAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const payload = await this.buildSddErrorPayload(
        workspacePath,
        sourceRunId,
        "DETAILING",
        message,
        "SDD_GENERATION_FAILED",
      );
      res.status(500).json(payload);
    }
  }

  async approveFile(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        if (meta.currentFile !== fileId) {
          res.status(409).json({ message: "only current file can be approved" });
          return;
        }
        const current = meta.files.find((item) => item.fileId === fileId);
        if (!current || (current.status !== "GENERATED" && current.status !== "REVIEWING")) {
          res.status(409).json({ message: "file is not in reviewable state" });
          return;
        }
        upsertFileState(meta, fileId, { status: "APPROVED", lastError: null });
        const nextFile = resolveCurrentFile(meta.files);
        meta.currentFile = nextFile;
        meta.stage = deriveStageFromCurrentFile(nextFile);
        meta.status = nextFile ? "RUNNING" : "DONE";
        await saveMeta(meta);
        emitTaskScopedEvent(runId, "FILE_APPROVED", { runId, fileId, status: "APPROVED" });
        emitTaskScopedEvent(runId, "RUN_POINTER_MOVED", { runId, stage: meta.stage, currentFile: meta.currentFile });
        if (meta.status === "DONE") {
          emitTaskScopedEvent(runId, "TASK_FINISHED", { runId, status: "DONE" });
        }
        await appendEventLog(workspacePath, runId, "FILE_APPROVED", { fileId });
        await appendEventLog(workspacePath, runId, "RUN_POINTER_MOVED", {
          currentFile: meta.currentFile,
          stage: meta.stage,
        });
      });
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async rejectFile(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    const reason = String(req.body?.reason ?? "").trim() || "rejected by user";
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        if (meta.currentFile !== fileId) {
          res.status(409).json({ message: "only current file can be rejected" });
          return;
        }
        const current = meta.files.find((item) => item.fileId === fileId);
        if (!current || (current.status !== "GENERATED" && current.status !== "REVIEWING")) {
          res.status(409).json({ message: "file is not in reviewable state" });
          return;
        }
        upsertFileState(meta, fileId, {
          status: "REJECTED",
          lastError: reason,
        });
        await saveMeta(meta);
        emitTaskScopedEvent(runId, "FILE_REJECTED", { runId, fileId, status: "REJECTED", reason });
        await appendEventLog(workspacePath, runId, "FILE_REJECTED", { fileId, reason });
      });
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async regenerateFile(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        if (meta.currentFile !== fileId) {
          res.status(409).json({ message: "only current file can be regenerated" });
          return;
        }
        const current = meta.files.find((item) => item.fileId === fileId);
        if (!current || (current.status !== "GENERATED" && current.status !== "REVIEWING" && current.status !== "REJECTED")) {
          res.status(409).json({ message: "file is not in regenerable state" });
          return;
        }
        upsertFileState(meta, fileId, { status: "PENDING", retries: current.retries + 1, lastError: null });
        await saveMeta(meta);
        emitTaskScopedEvent(runId, "FILE_REGENERATED", { runId, fileId, status: "PENDING" });
        await appendEventLog(workspacePath, runId, "FILE_REGENERATED", { fileId, attempt: current.retries + 1 });
        await filewiseGenerateCurrent(meta);
      });
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async saveEdit(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
      const content = String(req.body?.content ?? "");
      if (!content.trim()) {
        res.status(400).json({ message: "content is required" });
        return;
      }
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        if (meta.currentFile !== fileId) {
          res.status(409).json({ message: "only current file can be edited" });
          return;
        }
        const current = meta.files.find((item) => item.fileId === fileId);
        if (!current || (current.status !== "GENERATED" && current.status !== "REVIEWING" && current.status !== "REJECTED")) {
          res.status(409).json({ message: "file is not in editable state" });
          return;
        }
        await writeFileBody(workspacePath, runId, fileId, content);
        upsertFileState(meta, fileId, { status: "REVIEWING", lastError: null });
        await saveMeta(meta);
        emitTaskScopedEvent(runId, "FILE_EDITED", { runId, fileId, status: "REVIEWING" });
        await appendEventLog(workspacePath, runId, "FILE_EDITED", { fileId, size: content.length });
      });
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }
}
