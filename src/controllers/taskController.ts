import type { Request, Response } from "express";
import type { FileId } from "../services/taskService.js";
import {
  resolveWorkspacePath,
  listHistoryRecords,
  resolveHistoryRecord,
  readPreview,
  normalizeQuestionnaire,
  isStringOrStringArrayRecord,
  createOrResumeFilewiseRun,
  filewiseGenerateCurrent,
  filewiseGeneratePendingBaseFiles,
  listSddSourceRuns,
} from "../services/taskService.js";
import {
  withRunLock,
  getFileRuntimeRecord,
  toFileStatusResponse,
  ensureValidFileId,
  upsertFileState,
  resolveCurrentFile,
  deriveStageFromCurrentFile,
} from "../pipeline/stateMachine.js";
import {
  readMeta,
  saveMeta,
} from "../persistence/metaStore.js";
import {
  getRunLastEventAt,
  readRunEventsTail,
} from "../persistence/eventLog.js";
import {
  readFileBody,
  writeFileBody,
} from "../persistence/artifactStore.js";
import { emitTaskScopedEvent } from "../runtime/workflowEvents.js";
import { ARTIFACT_FILES } from "../constants/domainConstants.js";
import { appendRunEvent, log } from "../utils/logger.js";
import { getKnowledgeBase } from "../rag/index.js";

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";

export class TaskController {
  private isBaseFilesApproved(meta: Awaited<ReturnType<typeof readMeta>>): boolean {
    return meta.files.filter((f) => f.fileId !== "07").every((f) => f.status === "APPROVED");
  }

  private ensureSddFile(meta: Awaited<ReturnType<typeof readMeta>>): void {
    if (!meta.files.find((f) => f.fileId === "07")) {
      meta.files.push({
        fileId: "07",
        artifactName: ARTIFACT_FILES.sdd07,
        status: "PENDING",
        retries: 0,
        lastError: null,
        usedMcp: false,
        toolName: null,
        fallbackReason: null,
        updatedAt: new Date().toISOString(),
      });
    }
    meta.currentFile = "07";
    meta.stage = "DETAILING";
    upsertFileState(meta, "07", { status: "PENDING", lastError: null });
  }

  private applyLlmOverrides(meta: Awaited<ReturnType<typeof readMeta>>, llm: unknown): void {
    const llmRaw = llm && typeof llm === "object" ? (llm as Record<string, unknown>) : {};
    if (typeof llmRaw.baseUrl === "string" && llmRaw.baseUrl.trim()) {
      meta.llm.baseUrl = llmRaw.baseUrl.trim();
    }
    if (typeof llmRaw.apiKey === "string" && llmRaw.apiKey.trim()) {
      meta.llm.apiKey = llmRaw.apiKey.trim();
    }
    if (typeof llmRaw.modelName === "string" && llmRaw.modelName.trim()) {
      meta.llm.modelName = llmRaw.modelName.trim();
    }
  }

  private async generateSddCore(
    workspacePath: string,
    runId: string,
    meta: Awaited<ReturnType<typeof readMeta>>,
    options?: { appendAutoReviewLog?: boolean },
  ): Promise<void> {
    const runtime = getFileRuntimeRecord(meta);
    if (!meta.currentFile) {
      throw new Error("no current file to generate");
    }
    if (meta.currentFile !== "07") {
      throw new Error("sdd generation only supports file 07");
    }
    if (!runtime.actions.canGenerateNext) {
      throw new Error("file 07 is not ready for generation");
    }
    await filewiseGenerateCurrent(meta);
    let refreshed = await readMeta(workspacePath, runId);
    const sddFile = refreshed.files.find((item) => item.fileId === "07");
    if (!sddFile || (sddFile.status !== "GENERATED" && sddFile.status !== "REVIEWING")) {
      return;
    }
    upsertFileState(refreshed, "07", { status: "APPROVED", lastError: null });
    const nextFile = resolveCurrentFile(refreshed.files);
    refreshed.currentFile = nextFile;
    refreshed.stage = deriveStageFromCurrentFile(nextFile);
    refreshed.status = nextFile ? "RUNNING" : "DONE";
    await saveMeta(refreshed);
    emitTaskScopedEvent(runId, "FILE_APPROVED", { runId, fileId: "07", status: "APPROVED" });
    emitTaskScopedEvent(runId, "RUN_POINTER_MOVED", { runId, stage: refreshed.stage, currentFile: refreshed.currentFile });
    if (refreshed.status === "DONE") {
      emitTaskScopedEvent(runId, "TASK_FINISHED", { runId, status: "DONE" });
    }
    await appendRunEvent(workspacePath, runId, "FILE_APPROVED", { fileId: "07", auto: true });
    if (options?.appendAutoReviewLog) {
      await log(
        {
          run: runId,
          file: "07",
          stage: "DETAILING",
          level: "info",
          msg: "07 文件已生成并通过自动审核",
          extra: { auto: true },
        },
        async (type, data) => appendRunEvent(workspacePath, runId, type, data),
      );
    }
  }

  private inferSddErrorCode(message: string): string {
    const lowered = message.toLowerCase();
    if (lowered.includes("econnrefused") || lowered.includes("socket hang up") || lowered.includes("timeout")) {
      return "TASKS_LLM_CONNECTION_ERROR";
    }
    if (lowered.includes("timeout") || lowered.includes("aborted")) {
      return "TASKS_LLM_TIMEOUT";
    }
    if (lowered.includes("401") || lowered.includes("unauthorized") || lowered.includes("api key")) {
      return "TASKS_LLM_AUTH_ERROR";
    }
    if (lowered.includes("429") || lowered.includes("rate limit") || lowered.includes("quota")) {
      return "TASKS_LLM_RATE_LIMIT";
    }
    return "TASKS_GENERATION_FAILED";
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

  async chatCompletions(req: Request, res: Response) {
    try {
      const { messages, llm } = req.body;
      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ message: "messages array is required" });
        return;
      }
      if (!llm || !llm.apiKey) {
        res.status(400).json({ message: "llm config with apiKey is required" });
        return;
      }

      const model = new ChatOpenAI({
        model: llm.modelName || "deepseek-chat",
        apiKey: llm.apiKey,
        configuration: {
          baseURL: llm.baseUrl || "https://api.deepseek.com",
        },
        temperature: 0.7,
      });

      const langchainMessages = messages.map((m: any) => {
        if (m.role === "system") return new SystemMessage(m.content);
        if (m.role === "assistant") return new AIMessage(m.content);
        return new HumanMessage(m.content);
      });

      // Inject system prompt if not present
      if (langchainMessages[0]?._getType() !== "system") {
        langchainMessages.unshift(
          new SystemMessage(
            "You are an expert software architect acting as a design co-pilot. " +
            "Your goal is to help the user brainstorm, clarify, and solidify their software requirements. " +
            "Keep your responses concise, actionable, and conversational. " +
            "CRITICAL: Ask ONLY ONE question at a time. Do not overwhelm the user with a list of questions. Wait for their answer before asking the next one. " +
            "Use Markdown formatting (like **bold**, lists, etc.) to make your output readable. " +
            "Once you believe the requirements are clear enough to generate a formal design draft (01_需求草�?, " +
            "you should suggest the user click the '固化为草�?(Solidify to Draft)' button."
          )
        );
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await model.stream(langchainMessages);
      
      for await (const chunk of stream) {
        if (chunk.content) {
          res.write(`data: ${JSON.stringify({ text: chunk.content })}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ message });
      } else {
        res.end();
      }
    }
  }

  async startFilewiseTask(req: Request, res: Response) {
    const runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
    const requirement = String(req.body?.requirement ?? "").trim();
    const llm = req.body?.llm ?? {};
    const workspace = req.body?.workspace ?? {};
    const questionnaire = normalizeQuestionnaire(req.body?.questionnaire ?? null);
    const userAnswers = isStringOrStringArrayRecord(req.body?.userAnswers)
      ? req.body.userAnswers
      : {};
    const selectedModules = Array.isArray(req.body?.selectedModules)
      ? req.body.selectedModules.filter((item: unknown): item is string => typeof item === "string")
      : undefined;
    const ragKbId = typeof req.body?.ragKbId === "string" && req.body.ragKbId.trim()
      ? req.body.ragKbId.trim()
      : undefined;
    if (!requirement) {
      res.status(400).json({ message: "requirement is required" });
      return;
    }
    try {
      if (ragKbId) {
        const kb = await getKnowledgeBase(ragKbId);
        if (!kb) {
          res.status(400).json({ message: "invalid ragKbId" });
          return;
        }
      }
      const { meta, resumed } = await createOrResumeFilewiseRun({
        runId,
        requirement,
        llm,
        workspace,
        questionnaire,
        userAnswers,
        selectedModules,
        ragKbId,
      });
      res.json({
        runId: meta.runId,
        stage: meta.stage,
        currentFile: meta.currentFile,
        resumed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async bindRagKnowledgeBase(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    const ragKbId = typeof req.body?.ragKbId === "string" && req.body.ragKbId.trim()
      ? req.body.ragKbId.trim()
      : undefined;
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      if (ragKbId) {
        const kb = await getKnowledgeBase(ragKbId);
        if (!kb) {
          res.status(400).json({ message: "invalid ragKbId" });
          return;
        }
      }
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        meta.ragKbId = ragKbId;
        await saveMeta(meta);
      });
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
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
      const responseObj: any = {
        ...toFileStatusResponse(meta, workspacePath),
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
      const validFileId = ensureValidFileId(fileId);
      const content = await readFileBody(workspacePath, runId, validFileId);
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

  async updateModules(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    const { selectedModules } = req.body;

    if (!runId || !Array.isArray(selectedModules)) {
      res.status(400).json({ message: "runId and selectedModules array are required" });
      return;
    }

    try {
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        
        // Ensure 01 and 07 are always included
        const allowed = new Set([...selectedModules, "01", "07"]);
        
        // Keep ALL files in meta.files, but we can just update meta.selectedModules
        // The backend generation logic only generates files that are PENDING and != 07.
        // Wait, if unselected files are still PENDING, the concurrent generator WILL try to generate them!
        // So we MUST mark unselected files as SKIPPED so the generator ignores them.
        
        for (const f of meta.files) {
          if (!allowed.has(f.fileId)) {
            if (f.status === "PENDING" || f.status === "FAILED") {
              f.status = "REJECTED"; // "REJECTED" or "GENERATED" or we need to add "SKIPPED"? We can't easily add SKIPPED to the enum. 
              // Wait, if we just remove them, the frontend will hide them. That is perfectly fine and matches "直接置灰或隐�?!
            }
          }
        }
        
        // Remove files that are no longer selected
        meta.files = meta.files.filter(f => allowed.has(f.fileId));

        
        // Add files that are selected but missing
        const existingIds = new Set(meta.files.map(f => f.fileId));
        const allSpecs = [
          { fileId: "01", artifactName: ARTIFACT_FILES.modeling01 },
          { fileId: "02", artifactName: ARTIFACT_FILES.modeling02 },
          { fileId: "03", artifactName: ARTIFACT_FILES.modeling03 },
          { fileId: "04", artifactName: ARTIFACT_FILES.modeling04 },
          { fileId: "05", artifactName: ARTIFACT_FILES.detailing05 },
          { fileId: "06", artifactName: ARTIFACT_FILES.detailing06 },
          { fileId: "07", artifactName: ARTIFACT_FILES.sdd07 }
        ] as const;
        
        for (const spec of allSpecs) {
          if (allowed.has(spec.fileId) && !existingIds.has(spec.fileId)) {
            meta.files.push({
              fileId: spec.fileId as FileId,
              artifactName: spec.artifactName,
              status: "PENDING",
              retries: 0,
              lastError: null,
              usedMcp: false,
              toolName: null,
              fallbackReason: null,
              updatedAt: new Date().toISOString(),
            });
          }
        }
        
        // Sort files to maintain order
        const order = ["01", "02", "03", "04", "05", "06", "07"];
        meta.files.sort((a, b) => order.indexOf(a.fileId as string) - order.indexOf(b.fileId as string));
        
        meta.selectedModules = selectedModules;
        
        // Re-evaluate currentFile
        meta.currentFile = resolveCurrentFile(meta.files);
        meta.stage = deriveStageFromCurrentFile(meta.currentFile);
        
        await saveMeta(meta);
      });
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
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
        if (req.body.llm && req.body.llm.apiKey) {
          meta.llm = { ...meta.llm, ...req.body.llm };
        }
        const runtime = getFileRuntimeRecord(meta);
        if (!runtime.actions.canGenerateNext || !meta.currentFile) {
          res.status(409).json({ message: "no file is ready for generation", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        await filewiseGenerateCurrent(meta);
      });
      if (res.headersSent) {
        return;
      }
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
    } catch (error) {
      if (res.headersSent) {
        return;
      }
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
        if (req.body.llm && req.body.llm.apiKey) {
          meta.llm = { ...meta.llm, ...req.body.llm };
        }
        const runtime = getFileRuntimeRecord(meta);
        if (!runtime.actions.canGenerateNext || !meta.currentFile) {
          res.status(409).json({ message: "no file is ready for generation", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        if (meta.currentFile === "07") {
          res.status(409).json({ message: "base generation only supports file 01-07", ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        if (meta.currentFile === "01") {
          await filewiseGenerateCurrent(meta);
        } else {
          await filewiseGeneratePendingBaseFiles(meta);
        }
      });
      if (res.headersSent) {
        return;
      }
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
    } catch (error) {
      if (res.headersSent) {
        return;
      }
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
        if (req.body.llm && req.body.llm.apiKey) {
          meta.llm = { ...meta.llm, ...req.body.llm };
        }
        
        if (sourceRunId) {
          if (!this.isBaseFilesApproved(meta)) {
            res.status(409).json({ message: "历史任务未完成基础设计阶段审核通过，不能用于SDD生成" });
            return;
          }
          this.ensureSddFile(meta);
          meta.llm = currentMeta.llm;
          await saveMeta(meta);
          const freshMeta = await readMeta(workspacePath, targetRunId);
          freshMeta.llm = meta.llm;
          meta = freshMeta;
        }
        const runtime = getFileRuntimeRecord(meta);
        if (!meta.currentFile || meta.currentFile !== "07" || !runtime.actions.canGenerateNext) {
          const message = !meta.currentFile
            ? "no current file to generate"
            : meta.currentFile !== "07"
              ? "sdd generation only supports file 07"
              : "file 07 is not ready for generation";
          res.status(409).json({ message, ...toFileStatusResponse(meta, workspacePath) });
          return;
        }
        await this.generateSddCore(workspacePath, targetRunId, meta);
      });
      if (res.headersSent) {
        return;
      }
      const finalMeta = await readMeta(workspacePath, targetRunId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      if (res.headersSent) {
        return;
      }
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
        errorCode: "TASKS_SOURCE_RUN_ID_REQUIRED",
        stage: "DETAILING",
        lastEventAt: null,
      });
      return;
    }
    try {
      await withRunLock(sourceRunId, async () => {
        const sourceMeta = await readMeta(workspacePath, sourceRunId);
        if (!this.isBaseFilesApproved(sourceMeta)) {
          const payload = await this.buildSddErrorPayload(
            workspacePath,
            sourceRunId,
            "DETAILING",
            "历史任务未完成基础设计阶段审核通过，不能用于SDD生成",
            "TASKS_SOURCE_NOT_READY",
          );
          res.status(409).json(payload);
          return;
        }
        this.applyLlmOverrides(sourceMeta, llm);
        this.ensureSddFile(sourceMeta);
        await saveMeta(sourceMeta);
        const ready = await readMeta(workspacePath, sourceRunId);
        ready.llm = sourceMeta.llm;
        await this.generateSddCore(workspacePath, sourceRunId, ready, { appendAutoReviewLog: true });
      });
      if (res.headersSent) {
        return;
      }
      const finalRefreshed = await readMeta(workspacePath, sourceRunId);
      const lastEventAt = await getRunLastEventAt(workspacePath, sourceRunId);
      res.json({
        ...toFileStatusResponse(finalRefreshed, workspacePath),
        errorCode: null,
        stage: finalRefreshed.stage,
        lastEventAt,
      });
    } catch (error) {
      if (res.headersSent) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const payload = await this.buildSddErrorPayload(
        workspacePath,
        sourceRunId,
        "DETAILING",
        message,
        "TASKS_GENERATION_FAILED",
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
        await appendRunEvent(workspacePath, runId, "FILE_APPROVED", { fileId });
        await appendRunEvent(workspacePath, runId, "RUN_POINTER_MOVED", {
          currentFile: meta.currentFile,
          stage: meta.stage,
        });
      });
      if (res.headersSent) {
        return;
      }
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      if (res.headersSent) {
        return;
      }
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
        await appendRunEvent(workspacePath, runId, "FILE_REJECTED", { fileId, reason });
      });
      if (res.headersSent) {
        return;
      }
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      if (res.headersSent) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }

  async regenerateFile(req: Request, res: Response) {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
      let generatedMeta;
      await withRunLock(runId, async () => {
        const meta = await readMeta(workspacePath, runId);
        if (req.body.llm && req.body.llm.apiKey) {
          meta.llm = { ...meta.llm, ...req.body.llm };
        }
        const current = meta.files.find((item) => item.fileId === fileId);
        
        // For files 02-07 (which are generated concurrently), we don't enforce currentFile strict match
        // if they are in the concurrent generation block (stage === "SOLUTION_DESIGN" or "QUALITY_REVIEW" or "IMPLEMENTATION_BLUEPRINT")
        const isConcurrentFile = fileId !== "01" && fileId !== "07";
        
        if (meta.currentFile !== fileId && !isConcurrentFile) {
          res.status(409).json({ message: "only current file or concurrent base files can be regenerated" });
          return;
        }
        if (!current || (current.status !== "GENERATED" && current.status !== "REVIEWING" && current.status !== "REJECTED" && current.status !== "FAILED")) {
          res.status(409).json({ message: "file is not in regenerable state" });
          return;
        }
        
        upsertFileState(meta, fileId, { status: "PENDING", retries: current.retries + 1, lastError: null });
        await saveMeta(meta);
        emitTaskScopedEvent(runId, "FILE_REGENERATED", { runId, fileId, status: "PENDING" });
        await appendRunEvent(workspacePath, runId, "FILE_REGENERATED", { fileId, attempt: current.retries + 1 });
        
        // Use filewiseGenerateCurrent to only generate THIS specific file
        // Note: we trick the system by passing the meta but setting currentFile to the file we want to generate
        const originalCurrentFile = meta.currentFile;
        meta.currentFile = fileId;
        await filewiseGenerateCurrent(meta);
        
        // Restore original currentFile state if it was a concurrent file
        const updatedMeta = await readMeta(workspacePath, runId);
        updatedMeta.currentFile = originalCurrentFile;
        updatedMeta.stage = deriveStageFromCurrentFile(originalCurrentFile);
        await saveMeta(updatedMeta);
      });
      if (res.headersSent) {
        return;
      }
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      if (res.headersSent) {
        return;
      }
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
        await appendRunEvent(workspacePath, runId, "FILE_EDITED", { fileId, size: content.length });
      });
      if (res.headersSent) {
        return;
      }
      const finalMeta = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(finalMeta, workspacePath));
    } catch (error) {
      if (res.headersSent) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }
}
