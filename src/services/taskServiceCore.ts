import type { Express } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { ARTIFACT_FILES } from "../constants/domainConstants.js";
import { GateBlockedError, runQualityGate } from "../quality/index.js";
import { formatGateSummary } from "../quality/reporter.js";

import {
  DETAILING_NODE_SYSTEM_PROMPT,
  ELICITATION_NODE_SYSTEM_PROMPT,
  MODELING_NODE_SYSTEM_PROMPT,
  REVIEW_NODE_SYSTEM_PROMPT,
  TASKS_NODE_SYSTEM_PROMPT,
} from "../constants/promptTexts.js";
import {
  emitLogAdded,
  emitTaskScopedEvent,
} from "../runtime/workflowEvents.js";
import { loadSkillContext } from "../runtime/skillContext.js";
import {
  QuestionnaireSchema,
  type JapState,
} from "../state/japState.js";
import {
  clampText,
  splitRequirementBySections,
  summarizeText,
} from "../utils/stringUtils.js";
import { appendRunEvent, log } from "../utils/logger.js";
import {
  FILEWISE_STATUS_ORDER,
  createInitialFileStates,
  deriveStageFromCurrentFile,
  getFileRuntimeRecord,
  getFileSpec,
  ensureValidFileId,
  nowIso,
  resolveCurrentFile,
  toFileStatusResponse,
  upsertFileState,
  withRunLock,
  type ArtifactFileId,
  type FileId,
  type FileRunFileState,
  type FileRunMeta,
  type FileRunRuntimePaths,
  type FileRunStatus,
  type SddSourceRunSummary,
} from "../pipeline/stateMachine.js";
import { invokeStructuredWithJsonFallback } from "./structuredOutputFallback.js";
import { JapMcpClient } from "../tools/mcpClient.js";
import {
  listHistoryRecords,
  readPreview,
  resolveHistoryRecord,
  resolveRequirementFromRecord,
  type HistoryRecord,
  type HistoryType,
} from "./historyService.js";
import {
  loadAllArtifactContents,
  loadApprovedArtifactSummary,
  readFileBody as readArtifactFileBody,
  writeFileBody as writeArtifactFileBody,
} from "../persistence/artifactStore.js";
import { buildRagQuery } from "../rag/queryBuilder.js";

export {
  FILEWISE_STATUS_ORDER,
  createInitialFileStates,
  deriveStageFromCurrentFile,
  getFileRuntimeRecord,
  getFileSpec,
  ensureValidFileId,
  nowIso,
  resolveCurrentFile,
  toFileStatusResponse,
  upsertFileState,
  withRunLock,
};
export type {
  ArtifactFileId,
  FileId,
  FileRunFileState,
  FileRunMeta,
  FileRunRuntimePaths,
  FileRunStatus,
  SddSourceRunSummary,
};


export type LlmConfig = NonNullable<JapState["llmConfig"]>;
export type WorkspaceConfig = NonNullable<JapState["workspaceConfig"]>;

export {
  clampText,
  splitRequirementBySections,
  summarizeText,
};
export {
  listHistoryRecords,
  readPreview,
  resolveHistoryRecord,
  resolveRequirementFromRecord,
};
export type { HistoryRecord, HistoryType };

export function normalizeQuestionnaire(input: unknown): JapState["questionnaire"] {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}

export function isStringOrStringArrayRecord(
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

export function isLlmConfig(value: unknown): value is LlmConfig {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.baseUrl === "string" &&
    typeof value.apiKey === "string" &&
    typeof value.modelName === "string"
  );
}

export function isWorkspaceConfig(value: unknown): value is WorkspaceConfig {
  return isRecord(value) && typeof value.path === "string";
}

export function resolveWorkspacePath(input: unknown): string {
  if (typeof input === "string" && input.trim()) {
    return path.resolve(input.trim());
  }
  if (isWorkspaceConfig(input) && input.path.trim()) {
    return path.resolve(input.path.trim());
  }
  return path.resolve(process.cwd());
}

export function resolveOutputPath(input: unknown): string {
  if (isWorkspaceConfig(input) && input.path.trim()) {
    return path.resolve(input.path.trim());
  }
  return path.resolve(process.cwd(), "output");
}

export async function ensureOutputDirectoryWritable(outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  const probeFile = path.join(outputDir, `.jap-probe-${randomUUID()}.tmp`);
  await fs.writeFile(probeFile, "ok", "utf-8");
  await fs.unlink(probeFile);
}

export function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relative = path.relative(workspacePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function ensureInsideWorkspace(workspacePath: string, targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!isInsideWorkspace(workspacePath, resolved)) {
    throw new Error("Path is outside workspace.");
  }
  return resolved;
}

export function toWorkspaceRelativePath(workspacePath: string, targetPath: string): string {
  const relative = path.relative(workspacePath, targetPath);
  return relative.split(path.sep).join("/");
}

export async function listDirectoryNames(dirPath: string): Promise<string[]> {
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

const MODELING_FILE_IDS: ArtifactFileId[] = ["01", "02", "03", "04"];
const DETAILING_FILE_IDS: ArtifactFileId[] = ["05", "06", "07"];
const FILEWISE_CONTEXT_LIMIT = 10000;
const FILEWISE_OUTPUT_LIMIT = 16000;

const FILE_TO_ARTIFACT_KEY: Record<ArtifactFileId, string> = {
  "01": ARTIFACT_FILES.modeling01,
  "02": ARTIFACT_FILES.modeling02,
  "03": ARTIFACT_FILES.modeling03,
  "04": ARTIFACT_FILES.modeling04,
  "05": ARTIFACT_FILES.detailing05,
  "06": ARTIFACT_FILES.detailing06,
  "07": ARTIFACT_FILES.sdd07,
};

async function appendRunLog(meta: FileRunMeta, msg: string): Promise<void> {
  await log(
    { run: meta.runId, file: "07", stage: "DETAILING", level: "info", msg },
    async (type, data) => appendRunEvent(meta.workspacePath, meta.runId, type, data),
  );
}

export async function validateApiConsistency(meta: FileRunMeta, fileId: string, content: string): Promise<void> {
  void meta;
  void fileId;
  void content;
}

export function getRunPaths(workspacePath: string, runId: string): FileRunRuntimePaths {
  const runDir = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks", runId));
  return {
    runDir,
    metaPath: ensureInsideWorkspace(runDir, path.join(runDir, "meta.json")),
    eventsPath: ensureInsideWorkspace(runDir, path.join(runDir, "events.log")),
  };
}

function isBaseFilesApproved(meta: FileRunMeta): boolean {
  return meta.files
    .filter((item) => item.fileId !== "07")
    .every((item) => item.status === "APPROVED");
}

async function isBaseFilesReadyOnDisk(meta: FileRunMeta): Promise<boolean> {
  if (!isBaseFilesApproved(meta)) {
    return false;
  }
  const baseFiles = meta.files.filter((item) => item.fileId !== "07");
  for (const file of baseFiles) {
    const filePath = toRunFilePath(meta.workspacePath, meta.runId, file.fileId);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size === 0) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export async function listSddSourceRuns(
  workspacePath: string,
  currentRunId: string,
): Promise<SddSourceRunSummary[]> {
  const tasksDir = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks"));
  const runIds = await listDirectoryNames(tasksDir);
  const rows: SddSourceRunSummary[] = [];
  const promises = runIds.map(async (runId) => {
    if (!runId || runId === currentRunId) return;
    try {
      const meta = await readMeta(workspacePath, runId);
      const baseReady = await isBaseFilesReadyOnDisk(meta);
      rows.push({
        runId: meta.runId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        status: meta.status,
        stage: meta.stage,
        currentFile: meta.currentFile,
        baseReady,
      });
    } catch {
      // ignore
    }
  });
  await Promise.all(promises);
  return rows
    .filter((item) => item.baseReady)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 60);
}

export async function importBaseFilesFromRun(meta: FileRunMeta, sourceRunId: string): Promise<void> {
  const sourceMeta = await readMeta(meta.workspacePath, sourceRunId);
  if (!isBaseFilesApproved(sourceMeta)) {
    throw new Error("历史任务未完成基础设计阶段审核通过，不能用于SDD生成");
  }
  const baseFiles = meta.files.filter(f => f.fileId !== "07");
  for (const file of baseFiles) {
    const fileId = file.fileId;
    const body = await readFileBody(meta.workspacePath, sourceRunId, fileId);
    if (!body.trim()) {
      throw new Error(`历史任务 ${sourceRunId} 的文�?${fileId} 内容为空`);
    }
    await writeFileBody(meta.workspacePath, meta.runId, fileId, body);
    upsertFileState(meta, fileId, {
      status: "APPROVED",
      lastError: null,
      fallbackReason: `imported-from-${sourceRunId}`,
    });
  }
  upsertFileState(meta, "07", { status: "PENDING", lastError: null });
  await saveMeta(meta);
  await appendRunEvent(meta.workspacePath, meta.runId, "TASKS_SOURCE_IMPORTED", {
    sourceRunId,
    targetRunId: meta.runId,
  });
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

export async function appendEventLog(workspacePath: string, runId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const paths = getRunPaths(workspacePath, runId);
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.appendFile(
    paths.eventsPath,
    JSON.stringify({ at: nowIso(), runId, type, ...data }) + "\n",
    "utf-8",
  );
}

export type RunEventRecord = {
  at: string;
  runId: string;
  type: string;
  [key: string]: unknown;
};

export async function readRunEventsTail(workspacePath: string, runId: string, tail: number, cursor: number = 0): Promise<{ events: RunEventRecord[], nextCursor: number }> {
  const paths = getRunPaths(workspacePath, runId);
  let raw = "";
  let nextCursor = 0;
  try {
    const stats = await fs.stat(paths.eventsPath);
    nextCursor = stats.size;
    if (cursor > 0 && cursor <= stats.size) {
      const fd = await fs.open(paths.eventsPath, "r");
      const buffer = Buffer.alloc(stats.size - cursor);
      await fd.read(buffer, 0, buffer.length, cursor);
      await fd.close();
      raw = buffer.toString("utf-8");
    } else {
      raw = await fs.readFile(paths.eventsPath, "utf-8");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], nextCursor: 0 };
    }
    throw error;
  }
  const normalizedTail = Number.isFinite(tail) ? Math.max(1, Math.min(1000, Math.floor(tail))) : 200;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const slice = cursor > 0 ? lines : lines.slice(-normalizedTail);
  const out: RunEventRecord[] = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.type !== "string") {
        continue;
      }
      out.push({
        at: typeof parsed.at === "string" ? parsed.at : nowIso(),
        runId: typeof parsed.runId === "string" ? parsed.runId : runId,
        type: parsed.type,
        ...parsed,
      });
    } catch {
      continue;
    }
  }
  return { events: out, nextCursor };
}

export async function getRunLastEventAt(workspacePath: string, runId: string): Promise<string | null> {
  const { events } = await readRunEventsTail(workspacePath, runId, 1);
  return events[0]?.at ?? null;
}


export { loadAllArtifactContents, loadApprovedArtifactSummary };

export async function ensureRunDirectories(workspacePath: string, runId: string): Promise<FileRunRuntimePaths> {
  const paths = getRunPaths(workspacePath, runId);
  await fs.mkdir(paths.runDir, { recursive: true });
  return paths;
}

export function toRunFilePath(workspacePath: string, runId: string, fileId: FileId): string {
  const spec = getFileSpec(fileId);
  const paths = getRunPaths(workspacePath, runId);
  return ensureInsideWorkspace(paths.runDir, path.join(paths.runDir, spec.artifactName));
}

export async function readMeta(workspacePath: string, runId: string): Promise<FileRunMeta> {
  const paths = getRunPaths(workspacePath, runId);
  const raw = await fs.readFile(paths.metaPath, "utf-8");
  const parsed = JSON.parse(raw) as FileRunMeta;
  if (!parsed.runId || !Array.isArray(parsed.files)) {
    throw new Error("invalid run meta");
  }
  parsed.currentFile = resolveCurrentFile(parsed.files);
  parsed.stage = deriveStageFromCurrentFile(parsed.currentFile);
  if (!parsed.currentFile) {
    parsed.status = "DONE";
  }
  return parsed;
}

export async function saveMeta(meta: FileRunMeta): Promise<void> {
  const paths = await ensureRunDirectories(meta.workspacePath, meta.runId);
  meta.currentFile = resolveCurrentFile(meta.files);
  meta.stage = deriveStageFromCurrentFile(meta.currentFile);
  if (!meta.currentFile) {
    meta.status = "DONE";
  }
  meta.updatedAt = nowIso();
  
  const metaToSave = JSON.parse(JSON.stringify(meta));
  if (metaToSave.llm && metaToSave.llm.apiKey) {
    metaToSave.llm.apiKey = "***";
  }
  const tmpPath = `${paths.metaPath}.tmp-${randomUUID()}`;
  await writeJson(tmpPath, metaToSave);
  await fs.rename(tmpPath, paths.metaPath);
}

export async function writeFileBody(
  workspacePath: string,
  runId: string,
  fileId: FileId,
  content: string,
): Promise<string> {
  return writeArtifactFileBody(workspacePath, runId, fileId, content);
}

export async function readFileBody(workspacePath: string, runId: string, fileId: FileId): Promise<string> {
  return readArtifactFileBody(workspacePath, runId, fileId);
}

async function runGateOrThrow(meta: FileRunMeta, fileId: FileId, content: string): Promise<void> {
  const artifacts = await loadAllArtifactContents(meta);
  artifacts[fileId] = content;
  const gateReport = await runQualityGate(fileId, content, artifacts);
  await appendRunEvent(meta.workspacePath, meta.runId, "GATE_CHECK", {
    fileId,
    passed: gateReport.passed,
    errors: gateReport.totalErrors,
    warnings: gateReport.totalWarnings,
  });
  emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
    logType: gateReport.passed ? "SUCCESS" : "ERROR",
    title: `文件 ${fileId} 质量门禁`,
    summary: formatGateSummary(gateReport),
  });
  if (!gateReport.passed) {
    throw new GateBlockedError(gateReport);
  }
}

export function buildQASnapshot(meta: FileRunMeta): string {
  const questions = meta.questionnaire?.questions ?? [];
  return questions
    .slice(0, 30)
    .map((q) => {
      const answer = meta.userAnswers[q.id];
      const answerText = Array.isArray(answer) ? answer.join(" | ") : String(answer ?? "");
      return `Q:${q.questionText}\nA:${answerText || "N/A"}`;
    })
    .join("\n---\n");
}



export function createModel(meta: FileRunMeta, timeout: number): ChatOpenAI {
  return new ChatOpenAI({
    model: meta.llm.modelName || "deepseek-chat",
    apiKey: meta.llm.apiKey,
    configuration: {
      baseURL: meta.llm.baseUrl || "https://api.deepseek.com",
    },
    temperature: 0.1,
    timeout,
    maxRetries: 0,
  });
}

export function buildModelingPrompt(fileId: ArtifactFileId, requirement: string, approvedSummary: string, qa: string, skill: string): string {
  return [
    `Target file: ${FILE_TO_ARTIFACT_KEY[fileId]}`,
    "Requirement:",
    clampText(requirement, FILEWISE_CONTEXT_LIMIT),
    "",
    "Approved file summaries:",
    approvedSummary || "(none)",
    "",
    "Question and answer snapshot:",
    clampText(qa, 3000),
    "",
    "Constraints:",
    "Keep naming consistent with existing artifacts.",
    "Output complete file content for target only.",
    "",
    "Skill context:",
    clampText(skill, 2000),
  ].join("\n");
}

export function buildDetailingPrompt(fileId: ArtifactFileId, requirement: string, approvedSummary: string, skill: string): string {
  return [
    `Target file: ${FILE_TO_ARTIFACT_KEY[fileId]}`,
    "Requirement:",
    clampText(requirement, 2800),
    "",
    "Approved base artifact summaries:",
    approvedSummary || "(none)",
    "",
    "Constraints:",
    "Only output content within the target file responsibility.",
    "Do not write implementation details: DB table names, REST paths, component names, or directories.",
    "Do not add requirements outside existing requirement and approved artifacts.",
    "Use concise, actionable, constraint-oriented wording for development agents.",
    "",
    "Skill context:",
    clampText(skill, 1800),
  ].join("\n");
}

export function buildSddPrompt(requirement: string, approvedSummary: string, evidence: string, qa: string, skill: string): string {
  return [
    `Target file: ${ARTIFACT_FILES.sdd07}`,
    "Requirement:",
    clampText(requirement, FILEWISE_CONTEXT_LIMIT),
    "",
    "Intermediate artifact summaries (01-07):",
    approvedSummary || "(none)",
    "",
    "Evidence blocks (01-07 content excerpts):",
    evidence ? evidence : "(none)",
    "",
    "Question and answer snapshot:",
    clampText(qa, 3000),
    "",
    "Constraints:",
    "This file is SDD constraints overview, not implementation tasks.",
    "Only describe file-level scope source, terminology source, and cross-file constraints.",
    "Explicitly state which files cannot introduce new requirements.",
    "Do not include checklist tasks, API path details, DB table definitions, component names, or directory structures.",
    "Keep naming and terms consistent with existing artifacts.",
    "",
    "Skill context:",
    clampText(skill, 2500),
  ].join("\n");
}
export async function generateArtifactByLlm(
  meta: FileRunMeta,
  fileId: ArtifactFileId,
  approvedSummary: string,
  fallbackContextOnly: boolean,
  minimalist: boolean = false,
): Promise<string> {
  const model = createModel(meta, fallbackContextOnly ? 35000 : 45000);
  const skill = await loadSkillContext(meta.workspacePath);
  const qa = buildQASnapshot(meta);
  const requirement = fallbackContextOnly
    ? clampText(meta.requirement, 6000)
    : clampText(meta.requirement, FILEWISE_CONTEXT_LIMIT);

  const sddEvidence = fileId === "07" ? await loadSddEvidence(meta) : "";

  let extraPrompt = "";
  if (minimalist) {
    extraPrompt = "\nMINIMALIST MODE: Output ONLY the core structure, bullet points, and basic outlines. DO NOT include detailed explanations or long texts. Keep it as short as possible while preserving the structure.";
  } else {
    if (fileId === "01") {
      extraPrompt = "\nOnly output: goal, scope, user roles, core scenarios, and explicit out-of-scope items.";
    } else if (fileId === "02") {
      extraPrompt = "\nOnly output domain terms, definitions, field meaning, status words, and business terminology.";
    } else if (fileId === "03") {
      extraPrompt = "\nOnly output behavior rules, state transitions, permission boundaries, and exception handling rules.";
    } else if (fileId === "04") {
      extraPrompt = "\nOnly output capability intents such as create/query/review/export; do not write fixed REST paths.";
    } else if (fileId === "05") {
      extraPrompt = "\nOnly output developer-agent execution order, reading order, free-design area, and mandatory constraints.";
    } else if (fileId === "06") {
      extraPrompt = "\nOnly output acceptance criteria, test observation points, and completion judgment. Do not output test code.";
    }
  }

  const prompt =
    fileId === "07"
      ? buildSddPrompt(requirement, approvedSummary, sddEvidence, qa, skill) + extraPrompt
      : MODELING_FILE_IDS.includes(fileId)
        ? buildModelingPrompt(fileId, requirement, approvedSummary, qa, skill) + extraPrompt
        : buildDetailingPrompt(fileId, requirement, approvedSummary, skill) + extraPrompt;

  const baseSystemPrompt = MODELING_FILE_IDS.includes(fileId)
    ? MODELING_NODE_SYSTEM_PROMPT
    : fileId === "07"
      ? TASKS_NODE_SYSTEM_PROMPT
      : DETAILING_NODE_SYSTEM_PROMPT;

  const systemPrompt = baseSystemPrompt + "\n\nYou are generating a single file. Output ONLY the raw markdown content. DO NOT wrap it in JSON or any code blocks. No explanations, no filler. Ensure cross-file naming consistency.";

  const response = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(prompt),
  ]);

  let content = typeof response.content === "string" ? response.content : "";
  
  content = content.trim();
  if (content.startsWith("```")) {
    const lines = content.split("\n");
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];
    if (lines.length > 1 && firstLine && firstLine.startsWith("```")) {
      lines.shift();
      if (lastLine && lastLine.startsWith("```")) {
        lines.pop();
      }
      content = lines.join("\n").trim();
    }
  }

  if (!content) {
    throw new Error(`empty output for ${fileId}`);
  }
  return content;
}

export async function tryGenerateWithMcp(
  meta: FileRunMeta,
  fileId: FileId,
  approvedSummary: string,
): Promise<{ content: string; toolName: string } | null> {
  // 在云端测试环境强制禁�?MCP，避�?npx 下载卡死
  if (process.env.DISABLE_MCP === "true") {
    return null;
  }

  try {
    const client = await JapMcpClient.getSharedClient(meta.workspacePath);
    const result = await client.callTextToolByCandidates(
      [`generate_file_${fileId}`, "generate_design_file", "generate_artifact_file", "generate_artifact"],
      {
        fileId,
        requirement: clampText(meta.requirement, 2800),
        approvedSummary: clampText(approvedSummary, 2000),
      },
    );
    if (!result?.content?.trim()) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

async function withRagRequirement(
  meta: FileRunMeta,
  fileId: FileId,
  approvedSummary: string,
): Promise<FileRunMeta> {
  const kbIds = meta.ragKbIds?.filter((item) => typeof item === "string" && item.trim()) ?? [];
  if (kbIds.length === 0) {
    return meta;
  }
  try {
    const { RAGService, getKnowledgeBase } = await import("../rag/index.js");
    const existingKbIds = (
      await Promise.all(
        kbIds.map(async (kbId) => ((await getKnowledgeBase(kbId)) ? kbId : null)),
      )
    ).filter((item): item is string => Boolean(item));
    if (existingKbIds.length === 0) {
      return meta;
    }
    const service = new RAGService();
    const builtQuery = buildRagQuery({
      fileId,
      stage: meta.stage,
      requirement: meta.requirement,
      approvedSummary,
    });
    const ctx = await service.retrieveAndBuildAcrossKnowledgeBases(
      builtQuery.query,
      existingKbIds,
      {
        baseURL: meta.llm.baseUrl,
        apiKey: meta.llm.apiKey,
      },
    );
    if (!ctx.injectedPrompt.trim()) {
      return meta;
    }
    return {
      ...meta,
      requirement: `${meta.requirement}\n${ctx.injectedPrompt}`,
    };
  } catch (error) {
    await appendRunLog(meta, `[RAG] retrieve failed: ${String(error)}`);
    return meta;
  }
}

export async function runSingleFileGeneration(meta: FileRunMeta, fileId: FileId, attempt: number): Promise<{
  content: string;
  usedMcp: boolean;
  toolName: string | null;
  fallbackReason: string | null;
}> {
  const approvedSummary = await loadApprovedArtifactSummary(meta);
  const generationMeta = await withRagRequirement(meta, fileId, approvedSummary);
  const isFallback = attempt >= 2;
  const isMinimalist = attempt === 3;

  if (fileId === "07") {
    await appendRunLog(meta, "正在读取所有已生成的前置设计产�?..");
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在读取所有已生成的前置设计产�?..",
    });

    await appendRunLog(meta, "正在为您生成 SDD 约束总览...");
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在为您生成 SDD 约束总览...",
    });

    const content = await generateArtifactByLlm(
      generationMeta,
      "07",
      approvedSummary,
      isFallback,
      isMinimalist,
    );

    return {
      content,
      usedMcp: false,
      toolName: null,
      fallbackReason: null,
    };
  }
  
  if (attempt === 1) {
    const mcpResult = await tryGenerateWithMcp(generationMeta, fileId, approvedSummary);
    if (mcpResult) {
      return {
        content: mcpResult.content,
        usedMcp: true,
        toolName: mcpResult.toolName,
        fallbackReason: null,
      };
    }
  }

  const asArtifact = fileId as ArtifactFileId;

  try {
      const content = await generateArtifactByLlm(
      generationMeta,
      asArtifact,
      approvedSummary,
      isFallback,
      isMinimalist
    );
    return {
      content,
      usedMcp: false,
      toolName: null,
      fallbackReason: isMinimalist ? "switched to minimalist mode" : (isFallback ? "switched to fallback context" : "MCP tool unavailable"),
    };
  } catch (error) {
    const sections = splitRequirementBySections(generationMeta.requirement);
    if (sections.length <= 1) {
      throw error;
    }
    const chunks: string[] = [];
    for (const section of sections) {
      const patchMeta: FileRunMeta = {
        ...generationMeta,
        requirement: section,
      };
      const partial = await generateArtifactByLlm(patchMeta, asArtifact, approvedSummary, true, isMinimalist);
      chunks.push(partial);
    }
    const combined = clampText(chunks.join("\n\n"), FILEWISE_OUTPUT_LIMIT);
    return {
      content: combined,
      usedMcp: false,
      toolName: null,
      fallbackReason: "MCP tool unavailable; switched to section merge",
    };
  }
}

export async function filewiseGeneratePendingBaseFiles(meta: FileRunMeta): Promise<FileRunMeta> {
  const originalLlm = meta.llm;
  const recoveredMeta = await readMeta(meta.workspacePath, meta.runId).catch(() => meta);
  let repaired = false;
  for (const file of recoveredMeta.files) {
    if (file.status === "GENERATING") {
      upsertFileState(recoveredMeta, file.fileId, { status: "FAILED", lastError: "recovered-from-interrupted-run" });
      repaired = true;
    }
  }
  if (repaired) {
    await saveMeta(recoveredMeta);
  }
  meta = recoveredMeta;
  meta.llm = originalLlm;
  const allowed = new Set(meta.selectedModules && meta.selectedModules.length > 0 ? [...meta.selectedModules, "01", "07"] : ["01", "07"]);
  
  // Phase 1: MODELING (02, 03, 04)
  const modelingFiles = meta.files.filter(f => ["02", "03", "04"].includes(f.fileId) && allowed.has(f.fileId) && (f.status === "PENDING" || f.status === "FAILED" || f.status === "REJECTED"));
  
  if (modelingFiles.length > 0) {
    await executeConcurrentGeneration(meta, modelingFiles);
    return await readMeta(meta.workspacePath, meta.runId);
  }

  // Only proceed to Detailing if Modeling is all APPROVED
  const modelingReady = meta.files.filter(f => ["02", "03", "04"].includes(f.fileId) && allowed.has(f.fileId)).every(f => f.status === "APPROVED");
  
  if (!modelingReady) {
    return meta; // Still waiting for user to approve modeling files
  }

  // Phase 2: DETAILING (05, 06)
  const detailingFiles = meta.files.filter(f => ["05", "06"].includes(f.fileId) && allowed.has(f.fileId) && (f.status === "PENDING" || f.status === "FAILED" || f.status === "REJECTED"));
  
  if (detailingFiles.length > 0) {
    await executeConcurrentGeneration(meta, detailingFiles);
    return await readMeta(meta.workspacePath, meta.runId);
  }

  return meta;
}

async function executeConcurrentGeneration(meta: FileRunMeta, pendingFiles: FileRunFileState[]): Promise<void> {

  // Set all to GENERATING first
  for (const file of pendingFiles) {
    upsertFileState(meta, file.fileId, { status: "GENERATING", lastError: null });
    emitTaskScopedEvent(meta.runId, "FILE_STAGE_CHANGED", {
      runId: meta.runId,
      fileId: file.fileId,
      status: "GENERATING",
    });
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: `文件 ${file.fileId} 开始并发生成`,
      summary: `第 ${file.retries + 1} 次尝试`,
    });
    await appendRunEvent(meta.workspacePath, meta.runId, "FILE_STAGE_CHANGED", { fileId: file.fileId, status: "GENERATING" });
  }
  await saveMeta(meta);

  // Run generation concurrently
  const promises = pendingFiles.map(async (file) => {
    let lastError: unknown = null;
    let generated: any = null;
    let finalAttempt = 0;
    
    for (const attempt of [1, 2, 3]) {
      finalAttempt = attempt;
      try {
        generated = await runSingleFileGeneration(meta, file.fileId, attempt);
        await writeFileBody(meta.workspacePath, meta.runId, file.fileId, generated.content);
        await runGateOrThrow(meta, file.fileId, generated.content);
        await validateApiConsistency(meta, file.fileId, generated.content);
        return { file, success: true, generated, attempt };
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        await appendRunEvent(meta.workspacePath, meta.runId, "FILE_FAILED", { fileId: file.fileId, attempt, message });
        emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
          logType: "ERROR",
          title: `文件 ${file.fileId} 生成异常 (${attempt}/3)`,
          summary: message,
        });
      }
    }
    return { file, success: false, lastError, attempt: finalAttempt };
  });

  const results = await Promise.all(promises);

  // Read meta again to get latest state in case of other concurrent reads (though we hold lock)
  const freshMeta = await readMeta(meta.workspacePath, meta.runId);

  for (const result of results) {
    const fileId = result.file.fileId;
    if (result.success && result.generated) {
      const nextStatus: FileRunStatus = "GENERATED";
      upsertFileState(freshMeta, fileId, {
        status: nextStatus,
        retries: result.file.retries + result.attempt,
        usedMcp: result.generated.usedMcp,
        toolName: result.generated.toolName,
        fallbackReason: result.generated.fallbackReason,
        lastError: null,
      });
      emitTaskScopedEvent(freshMeta.runId, "FILE_GENERATED", {
        runId: freshMeta.runId,
        fileId,
        status: nextStatus,
      });
      emitTaskScopedEvent(freshMeta.runId, "LOG_ADDED", {
        logType: "SUCCESS",
        title: `文件 ${fileId} 生成成功`,
        summary: result.generated.fallbackReason
          ? `fallback=${result.generated.fallbackReason}`
          : result.generated.usedMcp
            ? `usedMcp=${result.generated.toolName || "unknown"}`
            : "使用内置模型生成",
      });
      await appendRunEvent(freshMeta.workspacePath, freshMeta.runId, "FILE_GENERATED", {
        fileId,
        status: nextStatus,
      });
    } else {
      const message = result.lastError instanceof Error ? result.lastError.message : String(result.lastError);
      upsertFileState(freshMeta, fileId, {
        status: "FAILED",
        retries: result.file.retries + result.attempt,
        lastError: message,
      });
      emitTaskScopedEvent(freshMeta.runId, "FILE_STAGE_CHANGED", {
        runId: freshMeta.runId,
        fileId,
        status: "FAILED",
        attempt: result.attempt,
        error: message,
      });
      emitTaskScopedEvent(freshMeta.runId, "LOG_ADDED", {
        logType: "ERROR",
        title: `文件 ${fileId} 生成最终失败`,
        summary: message,
      });
    }
  }

  await saveMeta(freshMeta);
}

export async function filewiseGenerateCurrent(meta: FileRunMeta): Promise<FileRunMeta> {
  const fileId = meta.currentFile;
  if (!fileId) {
    return meta;
  }
  const current = meta.files.find((item) => item.fileId === fileId);
  if (!current) {
    throw new Error("current file record not found");
  }
  const retryBase = current.retries;
  upsertFileState(meta, fileId, { status: "GENERATING", lastError: null });
  await saveMeta(meta);
  emitTaskScopedEvent(meta.runId, "FILE_STAGE_CHANGED", {
    runId: meta.runId,
    fileId,
    status: "GENERATING",
  });
  emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
    logType: "INFO",
    title: `文件 ${fileId} 开始生成`,
    summary: `第 ${retryBase + 1} 次尝试`,
  });
  await appendRunEvent(meta.workspacePath, meta.runId, "FILE_STAGE_CHANGED", { fileId, status: "GENERATING" });

  let lastError: unknown = null;
  for (const attempt of [1, 2, 3]) {
    try {
      const generated = await runSingleFileGeneration(meta, fileId, attempt);
      if (fileId === "07") {
        await appendRunLog(meta, "正在落盘 SDD 约束总览文件...");
        emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "正在落盘 SDD 约束总览文件...",
        });
      }
      await writeFileBody(meta.workspacePath, meta.runId, fileId, generated.content);
      await runGateOrThrow(meta, fileId, generated.content);
      
      // P3: 一致性校验守�?      await validateApiConsistency(meta, fileId, generated.content);

      if (fileId === "07") {
        await appendRunLog(meta, "SDD 约束总览生成完毕，准备提�?..");
        emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "SDD 约束总览生成完毕，准备提�?..",
        });
      }

      const nextStatus: FileRunStatus = "GENERATED";
      upsertFileState(meta, fileId, {
        status: nextStatus,
        retries: retryBase + attempt,
        usedMcp: generated.usedMcp,
        toolName: generated.toolName,
        fallbackReason: generated.fallbackReason,
        lastError: null,
      });
      await saveMeta(meta);
      emitTaskScopedEvent(meta.runId, "FILE_GENERATED", {
        runId: meta.runId,
        fileId,
        status: nextStatus,
      });
      emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
        logType: "SUCCESS",
        title: `文件 ${fileId} 生成成功`,
        summary: generated.fallbackReason
          ? `fallback=${generated.fallbackReason}`
          : generated.usedMcp
            ? `usedMcp=${generated.toolName || "unknown"}`
            : "使用内置模型生成",
      });
      await appendRunEvent(meta.workspacePath, meta.runId, "FILE_GENERATED", {
        fileId,
        status: nextStatus,
        usedMcp: generated.usedMcp,
        toolName: generated.toolName,
        fallbackReason: generated.fallbackReason,
      });
      return meta;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      
      if (fileId === "07") {
        const lowered = message.toLowerCase();
        const networkLike =
          lowered.includes("connection error") ||
          lowered.includes("timeout") ||
          lowered.includes("timed out") ||
          lowered.includes("econn") ||
          lowered.includes("socket hang up");
        await appendRunEvent(meta.workspacePath, meta.runId, "TASKS_FAILURE_SUMMARY", {
          fileId,
          top3: message || "SDD约束总览生成失败",
          suggestion: networkLike
            ? "检查LLM baseUrl/apiKey与网络连通性后重试"
            : "查看FILE_FAILED与LLM响应详情后重试",
        });
      }
      upsertFileState(meta, fileId, {
        status: "FAILED",
        retries: retryBase + attempt,
        lastError: message,
      });
      await saveMeta(meta);
      emitTaskScopedEvent(meta.runId, "FILE_STAGE_CHANGED", {
        runId: meta.runId,
        fileId,
        status: "FAILED",
        attempt,
        error: message,
      });
      emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
        logType: "ERROR",
        title: `文件 ${fileId} 生成失败(${attempt}/3)`,
        summary: message,
      });
      await appendRunEvent(meta.workspacePath, meta.runId, "FILE_FAILED", { fileId, attempt, message });
      if (attempt >= 3) {
        throw error;
      }
      emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
        logType: "INFO",
        title: `文件 ${fileId} 准备重试`,
        summary: `即将开始第 ${retryBase + attempt + 1} 次尝试`,
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("generation failed");
}

export async function createFilewiseRun(params: {
  runId?: string;
  requirement: string;
  llm: unknown;
  workspace: unknown;
  questionnaire: JapState["questionnaire"];
  userAnswers: Record<string, string | string[]>;
  selectedModules?: string[];
  ragKbIds?: string[];
}): Promise<FileRunMeta> {
  const workspacePath = resolveWorkspacePath(params.workspace);
  const taskRoot = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks"));
  await ensureOutputDirectoryWritable(taskRoot);
  const runId = typeof params.runId === "string" && params.runId.trim()
    ? params.runId.trim()
    : `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await ensureRunDirectories(workspacePath, runId);
  const llmRaw = isRecord(params.llm) ? params.llm : {};
  const llm: LlmConfig = {
    baseUrl: String(llmRaw.baseUrl || "https://api.deepseek.com"),
    apiKey: String(llmRaw.apiKey || ""),
    modelName: String(llmRaw.modelName || "deepseek-chat"),
  };
  const meta: FileRunMeta = {
    runId,
    workflowMode: "filewise",
    stage: "MODELING",
    currentFile: "01",
    requirement: params.requirement,
    questionnaire: params.questionnaire,
    userAnswers: params.userAnswers,
    llm,
    ...(params.ragKbIds && params.ragKbIds.length > 0 ? { ragKbIds: params.ragKbIds } : {}),
    workspacePath,
    status: "RUNNING",
    files: createInitialFileStates(params.selectedModules),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (params.selectedModules) {
    meta.selectedModules = params.selectedModules;
  }
  await saveMeta(meta);
  await appendRunEvent(workspacePath, runId, "RUN_CREATED", {
    stage: meta.stage,
    currentFile: meta.currentFile,
  });
  emitTaskScopedEvent(runId, "RUN_POINTER_MOVED", {
    runId,
    stage: meta.stage,
    currentFile: meta.currentFile,
  });
  return meta;
}

export async function createOrResumeFilewiseRun(params: {
  runId?: string;
  requirement: string;
  llm: unknown;
  workspace: unknown;
  questionnaire: JapState["questionnaire"];
  userAnswers: Record<string, string | string[]>;
  selectedModules?: string[];
  ragKbIds?: string[];
}): Promise<{ meta: FileRunMeta; resumed: boolean }> {
  const workspacePath = resolveWorkspacePath(params.workspace);
  if (params.runId && params.runId.trim()) {
    try {
      const existingMeta = await readMeta(workspacePath, params.runId.trim());
      return { meta: existingMeta, resumed: true };
    } catch {
    }
  }
  const meta = await createFilewiseRun({
    ...(params.runId ? { runId: params.runId } : {}),
    requirement: params.requirement,
    llm: params.llm,
    workspace: workspacePath,
    questionnaire: params.questionnaire,
    userAnswers: params.userAnswers,
    ...(params.selectedModules ? { selectedModules: params.selectedModules } : {}),
    ...(params.ragKbIds && params.ragKbIds.length > 0 ? { ragKbIds: params.ragKbIds } : {}),
  });
  return { meta, resumed: false };
}

function wssBroadcastTaskEvent(wss: WebSocketServer, runId: string, eventType: string, payload: any) {
  const msg = JSON.stringify({ type: `task-${eventType}`, runId, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}
async function loadSddEvidence(meta: FileRunMeta): Promise<string> {
  const maxCharsByFile: Partial<Record<FileId, number>> = {
    "01": 5000,
    "02": 8000,
    "03": 6000,
    "04": 12000,
    "05": 5000,
    "06": 5000,
  };

  const blocks: string[] = [];
  const baseFiles = meta.files.filter(f => f.fileId !== "07");
  for (const file of baseFiles) {
    const fileId = file.fileId;
    try {
      const raw = await readFileBody(meta.workspacePath, meta.runId, fileId);
      const text = raw.trim();
      if (!text) continue;
      const maxChars = maxCharsByFile[fileId] ?? 2000;
      blocks.push(`--- ${FILE_TO_ARTIFACT_KEY[fileId]} ---\n${clampText(text, maxChars)}\n`);
    } catch {
      continue;
    }
  }
  return blocks.join("\n");
}
