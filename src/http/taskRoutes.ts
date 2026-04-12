import type { Express } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { TASK_ROUTE_LOG_TEXT } from "../constants/logTexts.js";
import {
  beginTask,
  emitLogAdded,
  emitStageChanged,
  emitTaskFinished,
  endTask,
} from "../runtime/workflowEvents.js";
import { QuestionnaireSchema, type JapState } from "../state/japState.js";
import { japApp } from "../workflow/japGraph.js";

type LlmConfig = NonNullable<JapState["llmConfig"]>;
type WorkspaceConfig = NonNullable<JapState["workspaceConfig"]>;
type HistoryType = "task" | "draft";

type HistoryFileSet = {
  raw: string | null;
  normalized: string | null;
  final: string | null;
};

type HistoryRecord = {
  id: string;
  type: HistoryType;
  createdAt: string;
  createdAtMs: number;
  absoluteRoot: string;
  absolutePaths: HistoryFileSet;
  paths: {
    root: string;
    raw: string | null;
    normalized: string | null;
    final: string | null;
  };
  summary: string;
  requirementAvailable: boolean;
};

function normalizeQuestionnaire(input: unknown): JapState["questionnaire"] {
  if (input == null) {
    return null;
  }
  const normalized = Array.isArray(input) ? { questions: input } : input;
  const parsed = QuestionnaireSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}

function isStringOrStringArrayRecord(
  value: unknown,
): value is Record<string, string | string[]> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => {
    if (typeof item === "string") {
      return true;
    }
    return Array.isArray(item) && item.every((v) => typeof v === "string");
  });
}

function isLlmConfig(value: unknown): value is LlmConfig {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.baseUrl === "string" &&
    typeof value.apiKey === "string" &&
    typeof value.modelName === "string"
  );
}

function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  return isRecord(value) && typeof value.path === "string";
}

function resolveWorkspacePath(input: unknown): string {
  if (typeof input === "string" && input.trim()) {
    return path.resolve(input.trim());
  }
  if (isWorkspaceConfig(input) && input.path.trim()) {
    return path.resolve(input.path.trim());
  }
  return path.resolve(process.cwd());
}

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relative = path.relative(workspacePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureInsideWorkspace(workspacePath: string, targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!isInsideWorkspace(workspacePath, resolved)) {
    throw new Error("Path is outside workspace.");
  }
  return resolved;
}

function toWorkspaceRelativePath(workspacePath: string, targetPath: string): string {
  const relative = path.relative(workspacePath, targetPath);
  return relative.split(path.sep).join("/");
}

async function listDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    return items.filter((item) => item.isDirectory()).map((item) => item.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listFileNames(dirPath: string): Promise<string[]> {
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    return items.filter((item) => item.isFile()).map((item) => item.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function pickHistoryFile(
  dirPath: string,
  fileNames: string[],
  exactCandidates: string[],
  keywordCandidates: string[],
): string | null {
  const lowerToRaw = new Map(fileNames.map((name) => [name.toLowerCase(), name]));
  for (const exact of exactCandidates) {
    const matched = lowerToRaw.get(exact.toLowerCase());
    if (matched) {
      return path.join(dirPath, matched);
    }
  }
  const fuzzy = fileNames.find((name) => {
    const lowered = name.toLowerCase();
    return keywordCandidates.every((keyword) => lowered.includes(keyword));
  });
  return fuzzy ? path.join(dirPath, fuzzy) : null;
}

async function getHistoryFileSet(workspacePath: string, historyDirPath: string): Promise<HistoryFileSet> {
  const fileNames = await listFileNames(historyDirPath);
  const rawPath = pickHistoryFile(
    historyDirPath,
    fileNames,
    ["00_prd_mcp_raw.md", "raw_requirement.md", "requirement_raw.md"],
    ["raw"],
  );
  const normalizedPath = pickHistoryFile(
    historyDirPath,
    fileNames,
    ["01_prd_mcp_normalized.md", "normalized_requirement.md", "requirement_normalized.md"],
    ["normalized"],
  );
  const finalPath = pickHistoryFile(
    historyDirPath,
    fileNames,
    ["03_final_requirement_fused.md", "final_requirement_fused.md", "final_requirement.md"],
    ["final", "requirement"],
  );
  return {
    raw: rawPath ? ensureInsideWorkspace(workspacePath, rawPath) : null,
    normalized: normalizedPath ? ensureInsideWorkspace(workspacePath, normalizedPath) : null,
    final: finalPath ? ensureInsideWorkspace(workspacePath, finalPath) : null,
  };
}

async function readPreview(filePath: string | null, maxChars: number): Promise<{
  exists: boolean;
  path: string | null;
  size: number;
  truncated: boolean;
  content: string;
}> {
  if (!filePath) {
    return {
      exists: false,
      path: null,
      size: 0,
      truncated: false,
      content: "",
    };
  }
  const stat = await fs.stat(filePath);
  const content = await fs.readFile(filePath, "utf-8");
  const truncated = content.length > maxChars;
  return {
    exists: true,
    path: filePath,
    size: stat.size,
    truncated,
    content: truncated ? content.slice(0, maxChars) : content,
  };
}

function cleanupSummaryText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

async function buildHistoryRecord(
  workspacePath: string,
  id: string,
  type: HistoryType,
  absoluteRoot: string,
): Promise<HistoryRecord> {
  const stat = await fs.stat(absoluteRoot);
  const fileSet = await getHistoryFileSet(workspacePath, absoluteRoot);
  let summary = "";
  for (const currentPath of [fileSet.final, fileSet.normalized, fileSet.raw]) {
    const preview = await readPreview(currentPath, 400);
    const candidate = cleanupSummaryText(preview.content).slice(0, 180);
    if (candidate) {
      summary = candidate;
      break;
    }
  }
  return {
    id,
    type,
    createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    createdAtMs: stat.birthtimeMs || stat.mtimeMs,
    absoluteRoot,
    absolutePaths: fileSet,
    paths: {
      root: toWorkspaceRelativePath(workspacePath, absoluteRoot),
      raw: fileSet.raw ? toWorkspaceRelativePath(workspacePath, fileSet.raw) : null,
      normalized: fileSet.normalized ? toWorkspaceRelativePath(workspacePath, fileSet.normalized) : null,
      final: fileSet.final ? toWorkspaceRelativePath(workspacePath, fileSet.final) : null,
    },
    summary,
    requirementAvailable: Boolean(fileSet.final || fileSet.normalized || fileSet.raw),
  };
}

async function listHistoryRecords(workspacePath: string): Promise<HistoryRecord[]> {
  const tasksDir = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks"));
  const draftsDir = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "_draft"));
  const taskNames = await listDirectoryNames(tasksDir);
  const draftNames = await listDirectoryNames(draftsDir);

  const records = await Promise.all([
    ...taskNames.map((name) =>
      buildHistoryRecord(workspacePath, name, "task", ensureInsideWorkspace(tasksDir, path.join(tasksDir, name))),
    ),
    ...draftNames.map((name) =>
      buildHistoryRecord(workspacePath, name, "draft", ensureInsideWorkspace(draftsDir, path.join(draftsDir, name))),
    ),
  ]);

  return records.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

async function resolveHistoryRecord(
  workspacePath: string,
  id: string,
  typeHint?: HistoryType,
): Promise<HistoryRecord | null> {
  const typeCandidates: HistoryType[] = typeHint ? [typeHint] : ["task", "draft"];
  for (const type of typeCandidates) {
    const baseDir = type === "task" ? path.join(workspacePath, "tasks") : path.join(workspacePath, "_draft");
    const safeBaseDir = ensureInsideWorkspace(workspacePath, baseDir);
    const candidateDir = ensureInsideWorkspace(safeBaseDir, path.join(safeBaseDir, id));
    try {
      const stat = await fs.stat(candidateDir);
      if (!stat.isDirectory()) {
        continue;
      }
      return await buildHistoryRecord(workspacePath, id, type, candidateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return null;
}

async function readRequirementText(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error("Requirement file is too large.");
  }
  return fs.readFile(filePath, "utf-8");
}

async function resolveRequirementFromRecord(record: HistoryRecord): Promise<{
  source: "final" | "normalized" | "raw";
  path: string;
  text: string;
} | null> {
  const candidates: Array<{ source: "final" | "normalized" | "raw"; path: string | null }> = [
    { source: "final", path: record.absolutePaths.final },
    { source: "normalized", path: record.absolutePaths.normalized },
    { source: "raw", path: record.absolutePaths.raw },
  ];

  for (const candidate of candidates) {
    if (!candidate.path) {
      continue;
    }
    const text = (await readRequirementText(candidate.path)).trim();
    if (text) {
      return {
        source: candidate.source,
        path: candidate.path,
        text,
      };
    }
  }
  return null;
}

function buildGraphInput(state: JapState): Record<string, unknown> {
  return {
    originalRequirement: state.originalRequirement,
    questionnaire: state.questionnaire,
    userAnswers: state.userAnswers,
    artifacts: state.artifacts,
    errors: state.errors,
    llmConfig: state.llmConfig,
    workspaceConfig: state.workspaceConfig,
  };
}

function runDesignTask(taskId: string, state: JapState, sourceHistoryId?: string): void {
  setImmediate(async () => {
    beginTask(taskId);
    emitStageChanged("DISCOVERY");
    emitLogAdded("INFO", TASK_ROUTE_LOG_TEXT.createdTitle, TASK_ROUTE_LOG_TEXT.createdSummary);
    if (sourceHistoryId) {
      emitLogAdded("INFO", "History source", sourceHistoryId);
    }

    try {
      const rawState = await japApp.invoke(buildGraphInput(state), {
        recursionLimit: 25,
      });
      const finalState = asJapState(rawState);

      if (finalState.errors?.length) {
        emitStageChanged("ERROR");
        emitLogAdded(
          "ERROR",
          TASK_ROUTE_LOG_TEXT.failedTitle,
          finalState.errors.join(" | ") || TASK_ROUTE_LOG_TEXT.failedFallbackSummary,
        );
        emitTaskFinished("ERROR", {
          errors: finalState.errors,
          artifactCount: Object.keys(finalState.artifacts ?? {}).length,
        });
      } else {
        emitStageChanged("DONE");
        emitLogAdded(
          "SUCCESS",
          TASK_ROUTE_LOG_TEXT.doneTitle,
          `${TASK_ROUTE_LOG_TEXT.doneSummaryPrefix} ${
            Object.keys(finalState.artifacts ?? {}).length
          } ${TASK_ROUTE_LOG_TEXT.doneSummarySuffix}`,
        );
        emitTaskFinished("DONE", {
          artifactCount: Object.keys(finalState.artifacts ?? {}).length,
          artifacts: Object.keys(finalState.artifacts ?? {}),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitStageChanged("ERROR");
      emitLogAdded("ERROR", TASK_ROUTE_LOG_TEXT.errorTitle, message);
      emitTaskFinished("ERROR", { errors: [message] });
    } finally {
      endTask();
    }
  });
}

function asJapState(value: unknown): JapState {
  if (!isRecord(value)) {
    throw new Error("Workflow returned invalid state object.");
  }

  const candidate = value;
  if (typeof candidate.originalRequirement !== "string") {
    throw new Error("Workflow state missing originalRequirement.");
  }
  if (!isStringRecord(candidate.artifacts)) {
    throw new Error("Workflow state has invalid artifacts field.");
  }
  if (!Array.isArray(candidate.errors) || !candidate.errors.every((item) => typeof item === "string")) {
    throw new Error("Workflow state has invalid errors field.");
  }
  if (!isStringOrStringArrayRecord(candidate.userAnswers)) {
    throw new Error("Workflow state has invalid userAnswers field.");
  }

  const questionnaire = normalizeQuestionnaire(candidate.questionnaire);
  return {
    originalRequirement: candidate.originalRequirement,
    questionnaire,
    userAnswers: candidate.userAnswers,
    artifacts: candidate.artifacts,
    errors: candidate.errors,
    llmConfig: isLlmConfig(candidate.llmConfig) ? candidate.llmConfig : null,
    workspaceConfig: isWorkspaceConfig(candidate.workspaceConfig)
      ? candidate.workspaceConfig
      : null,
  };
}

export function registerTaskRoutes(app: Express): void {
  app.get("/api/v1/history/requirements", async (req, res) => {
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
  });

  app.get("/api/v1/history/requirements/:id", async (req, res) => {
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
  });

  app.post("/api/v1/tasks/design-only", async (req, res) => {
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

    const taskId = randomUUID();
    res.json({ taskId, status: "DISCOVERY" });

    const state: JapState = {
      originalRequirement: requirement,
      questionnaire,
      userAnswers,
      artifacts: {},
      errors: [],
      llmConfig: {
        baseUrl: String(llm.baseUrl || "https://api.deepseek.com"),
        apiKey: String(llm.apiKey || ""),
        modelName: String(llm.modelName || "deepseek-chat"),
      },
      workspaceConfig: workspace.path ? { path: String(workspace.path) } : null,
    };
    runDesignTask(taskId, state);
  });

  app.post("/api/v1/tasks/design-from-history", async (req, res) => {
    const historyId = String(req.body?.historyId ?? "").trim();
    const historyTypeRaw = String(req.body?.historyType ?? "").trim().toLowerCase();
    const historyType: HistoryType | undefined =
      historyTypeRaw === "task" || historyTypeRaw === "draft" ? historyTypeRaw : undefined;
    const llm = req.body?.llm ?? {};
    const workspacePath = resolveWorkspacePath(req.body?.workspace);

    if (!historyId) {
      res.status(400).json({ message: "historyId is required" });
      return;
    }

    try {
      const record = await resolveHistoryRecord(workspacePath, historyId, historyType);
      if (!record) {
        res.status(404).json({ message: "history record not found" });
        return;
      }

      const requirementPayload = await resolveRequirementFromRecord(record);
      if (!requirementPayload) {
        res.status(400).json({ message: "history requirement content is empty" });
        return;
      }

      const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const taskOutputDir = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks", taskId));
      await fs.mkdir(taskOutputDir, { recursive: true });

      res.json({
        taskId,
        sourceHistoryId: historyId,
        sourceHistoryType: record.type,
        sourceRequirementFile: toWorkspaceRelativePath(workspacePath, requirementPayload.path),
        sourceRequirementType: requirementPayload.source,
        outputDir: taskOutputDir,
        status: "DISCOVERY",
      });

      const state: JapState = {
        originalRequirement: requirementPayload.text,
        questionnaire: null,
        userAnswers: {},
        artifacts: {},
        errors: [],
        llmConfig: {
          baseUrl: String(llm.baseUrl || "https://api.deepseek.com"),
          apiKey: String(llm.apiKey || ""),
          modelName: String(llm.modelName || "deepseek-chat"),
        },
        workspaceConfig: {
          path: taskOutputDir,
        },
      };
      runDesignTask(taskId, state, historyId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  });
}
