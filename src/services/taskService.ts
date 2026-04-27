import type { Express } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { ARTIFACT_FILES } from "../constants/domainConstants.js";

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
import { invokeStructuredWithJsonFallback } from "./structuredOutputFallback.js";
import { JapMcpClient } from "../tools/mcpClient.js";


export type LlmConfig = NonNullable<JapState["llmConfig"]>;
export type WorkspaceConfig = NonNullable<JapState["workspaceConfig"]>;
export type HistoryType = "task" | "draft";

export type HistoryFileSet = {
  raw: string | null;
  normalized: string | null;
  final: string | null;
};

export type HistoryRecord = {
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

export async function listFileNames(dirPath: string): Promise<string[]> {
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

export function pickHistoryFile(
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

export async function getHistoryFileSet(workspacePath: string, historyDirPath: string): Promise<HistoryFileSet> {
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

export async function readPreview(filePath: string | null, maxChars: number): Promise<{
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
  const truncated = stat.size > maxChars;
  let content = "";
  if (stat.size > 0) {
    const bytesToRead = Math.min(stat.size, maxChars * 4); // maxChars is characters, roughly 4 bytes per UTF-8 char max
    const fd = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fd.read(buffer, 0, bytesToRead, 0);
    await fd.close();
    content = buffer.toString("utf-8", 0, bytesRead);
    if (content.length > maxChars) {
      content = content.slice(0, maxChars);
    }
  }
  return {
    exists: true,
    path: filePath,
    size: stat.size,
    truncated,
    content,
  };
}

export function cleanupSummaryText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export async function buildHistoryRecord(
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

export async function listHistoryRecords(workspacePath: string): Promise<HistoryRecord[]> {
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

export async function resolveHistoryRecord(
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

export async function readRequirementText(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error("Requirement file is too large.");
  }
  return fs.readFile(filePath, "utf-8");
}

export async function resolveRequirementFromRecord(record: HistoryRecord): Promise<{
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



export type FileRunStatus = "PENDING" | "GENERATING" | "GENERATED" | "REVIEWING" | "APPROVED" | "REJECTED" | "FAILED";
export type FileRunStage = "MODELING" | "REVIEW" | "DETAILING" | "DONE";
export type FileRunMode = "legacy" | "filewise";

const FILEWISE_STATUS_ORDER = ["01", "02", "03", "04", "05", "06", "07"] as const;
export type FileId = (typeof FILEWISE_STATUS_ORDER)[number];
export type ArtifactFileId = FileId;

export type FileSpec = {
  fileId: FileId;
  stage: Exclude<FileRunStage, "DONE">;
  artifactName: string;
  ext: "md";
};

const FILE_SPECS: ReadonlyArray<FileSpec> = [
  { fileId: "01", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling01, ext: "md" },
  { fileId: "02", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling02, ext: "md" },
  { fileId: "03", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling03, ext: "md" },
  { fileId: "04", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling04, ext: "md" },
  { fileId: "05", stage: "DETAILING", artifactName: ARTIFACT_FILES.detailing05, ext: "md" },
  { fileId: "06", stage: "DETAILING", artifactName: ARTIFACT_FILES.detailing06, ext: "md" },
  { fileId: "07", stage: "DETAILING", artifactName: ARTIFACT_FILES.sdd07, ext: "md" },
];

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

export type FileRunFileState = {
  fileId: FileId;
  artifactName: string;
  status: FileRunStatus;
  retries: number;
  lastError: string | null;
  usedMcp: boolean;
  toolName: string | null;
  fallbackReason: string | null;
  updatedAt: string;
};

export async function validateApiConsistency(meta: FileRunMeta, fileId: string, content: string): Promise<void> {
  void meta;
  void fileId;
  void content;
}

type FileRunMeta = {
  runId: string;
  workflowMode: FileRunMode;
  stage: FileRunStage;
  currentFile: FileId | null;
  requirement: string;
  questionnaire: JapState["questionnaire"];
  userAnswers: Record<string, string | string[]>;
  llm: LlmConfig;
  workspacePath: string;
  selectedModules?: string[]; // Add selected modules for A la Carte Design
  status: "RUNNING" | "DONE" | "FAILED";
  files: FileRunFileState[];
  createdAt: string;
  updatedAt: string;
};



export type FileRunRuntimePaths = {
  runDir: string;
  metaPath: string;
  eventsPath: string;
};

export type FileRuntimeRecord = {
  runId: string;
  stage: FileRunStage;
  currentFile: FileId | null;
  files: FileRunFileState[];
  actions: {
    canGenerateNext: boolean;
    canApprove: boolean;
    canReject: boolean;
    canRegenerate: boolean;
    canSaveEdit: boolean;
  };
};

export type SddSourceRunSummary = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: FileRunMeta["status"];
  stage: FileRunStage;
  currentFile: FileId | null;
  baseReady: boolean;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function getFileSpec(fileId: FileId): FileSpec {
  const spec = FILE_SPECS.find((item) => item.fileId === fileId);
  if (!spec) {
    throw new Error(`Unknown fileId: ${fileId}`);
  }
  return spec;
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
      throw new Error(`历史任务 ${sourceRunId} 的文件 ${fileId} 内容为空`);
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
  await appendEventLog(meta.workspacePath, meta.runId, "TASKS_SOURCE_IMPORTED", {
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

export function deriveStageFromCurrentFile(fileId: FileId | null): FileRunStage {
  if (!fileId) {
    return "DONE";
  }
  return ["05", "06", "07"].includes(fileId as string) ? "DETAILING" : "MODELING";
}

export function resolveCurrentFile(files: FileRunFileState[]): FileId | null {
  for (const id of FILEWISE_STATUS_ORDER) {
    const found = files.find((item) => item.fileId === id);
    if (found && found.status !== "APPROVED") {
      return id;
    }
  }
  return null;
}

export function getFileRuntimeRecord(meta: FileRunMeta): FileRuntimeRecord {
  const current = meta.currentFile ? meta.files.find((item) => item.fileId === meta.currentFile) ?? null : null;
  const currentStatus = current?.status ?? null;
  const sddPrerequisitesReady =
    meta.currentFile !== "07" ||
    meta.files.filter((item) => item.fileId !== "07").every((item) => item.status === "APPROVED");
  const baseCanGenerateNext = currentStatus === "PENDING" || currentStatus === "FAILED" || currentStatus === "REJECTED";
  return {
    runId: meta.runId,
    stage: meta.stage,
    currentFile: meta.currentFile,
    files: meta.files,
    actions: {
      canGenerateNext: baseCanGenerateNext && sddPrerequisitesReady,
      canApprove: currentStatus === "GENERATED" || currentStatus === "REVIEWING",
      canReject: currentStatus === "GENERATED" || currentStatus === "REVIEWING",
      canRegenerate: currentStatus !== null && currentStatus !== "GENERATING",
      canSaveEdit:
        currentStatus === "GENERATED" ||
        currentStatus === "REVIEWING" ||
        currentStatus === "REJECTED" ||
        currentStatus === "FAILED",
    },
  };
}

export function toFileStatusResponse(meta: FileRunMeta, workspacePath: string): Record<string, unknown> {
  return {
    runId: meta.runId,
    workflowMode: meta.workflowMode,
    status: meta.status,
    stage: meta.stage,
    currentFile: meta.currentFile,
    workspacePath,
    files: meta.files,
    actions: getFileRuntimeRecord(meta).actions,
    selectedModules: meta.selectedModules,
  };
}

export function createInitialFileStates(selectedModules?: string[]): FileRunFileState[] {
  const now = nowIso();
  let specs = FILE_SPECS;
  if (selectedModules && selectedModules.length > 0) {
    const allowed = new Set([...selectedModules, "01", "07"]);
    specs = FILE_SPECS.filter((spec) => allowed.has(spec.fileId));
  }
  return specs.map((spec) => ({
    fileId: spec.fileId,
    artifactName: spec.artifactName,
    status: "PENDING",
    retries: 0,
    lastError: null,
    usedMcp: false,
    toolName: null,
    fallbackReason: null,
    updatedAt: now,
  }));
}

export function ensureValidFileId(value: string): FileId {
  if (FILEWISE_STATUS_ORDER.includes(value as FileId)) {
    return value as FileId;
  }
  throw new Error("invalid fileId");
}

export function splitRequirementBySections(requirement: string): string[] {
  const normalized = requirement.trim();
  if (!normalized) {
    return [];
  }
  const chunks = normalized
    .split(/\n(?=#{1,3}\s)|\n{2,}/g)
    .map((item) => item.trim())
    .filter(Boolean);
  if (chunks.length <= 1) {
    return [normalized.slice(0, FILEWISE_CONTEXT_LIMIT)];
  }
  const merged: string[] = [];
  let bucket = "";
  for (const chunk of chunks) {
    if ((bucket + "\n\n" + chunk).length > FILEWISE_CONTEXT_LIMIT && bucket) {
      merged.push(bucket);
      bucket = chunk;
    } else {
      bucket = bucket ? `${bucket}\n\n${chunk}` : chunk;
    }
  }
  if (bucket) {
    merged.push(bucket);
  }
  return merged.slice(0, 6);
}

export function clampText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}\n\n[truncated]`;
}

export function summarizeText(input: string): string {
  const cleaned = input.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 240) {
    return cleaned;
  }
  return `${cleaned.slice(0, 140)} ... ${cleaned.slice(-80)}`;
}

const approvedSummaryCache = new Map<string, { mtime: number, summary: string }>();

export async function loadApprovedArtifactSummary(meta: FileRunMeta): Promise<string> {
  const records: string[] = [];
  const promises = meta.files.map(async (file) => {
    if (file.status !== "APPROVED") {
      return null;
    }
    const filePath = toRunFilePath(meta.workspacePath, meta.runId, file.fileId);
    try {
      const stat = await fs.stat(filePath);
      const cacheKey = `${filePath}:${stat.mtimeMs}`;
      if (approvedSummaryCache.has(filePath)) {
        const cached = approvedSummaryCache.get(filePath)!;
        if (cached.mtime === stat.mtimeMs) {
          return `${file.fileId} ${file.artifactName}: ${cached.summary}`;
        }
      }
      
      const content = await fs.readFile(filePath, "utf-8");
      if (!content.trim()) {
        return null;
      }
      const summary = summarizeText(content);
      approvedSummaryCache.set(filePath, { mtime: stat.mtimeMs, summary });
      
      // Auto cleanup cache if it grows too large (e.g. > 1000 entries)
      if (approvedSummaryCache.size > 1000) {
        const keysToEvict = Array.from(approvedSummaryCache.keys()).slice(0, 200);
        for (const key of keysToEvict) {
          approvedSummaryCache.delete(key);
        }
      }
      
      return `${file.fileId} ${file.artifactName}: ${summary}`;
    } catch {
      return null;
    }
  });

  const results = await Promise.all(promises);
  for (const res of results) {
    if (res) records.push(res);
  }
  return records.join("\n");
}

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
  await writeJson(paths.metaPath, metaToSave);
}

export async function writeFileBody(
  workspacePath: string,
  runId: string,
  fileId: FileId,
  content: string,
): Promise<string> {
  const filePath = toRunFilePath(workspacePath, runId, fileId);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function readFileBody(workspacePath: string, runId: string, fileId: FileId): Promise<string> {
  const filePath = toRunFilePath(workspacePath, runId, fileId);
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function upsertFileState(meta: FileRunMeta, fileId: FileId, patch: Partial<FileRunFileState>): void {
  const idx = meta.files.findIndex((item) => item.fileId === fileId);
  if (idx < 0) {
    throw new Error(`file state not found: ${fileId}`);
  }
  const existing = meta.files[idx];
  if (!existing) {
    throw new Error(`file state not found: ${fileId}`);
  }
  meta.files[idx] = {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  };
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
  // 在云端测试环境强制禁用 MCP，避免 npx 下载卡死
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

export async function runSingleFileGeneration(meta: FileRunMeta, fileId: FileId, attempt: number): Promise<{
  content: string;
  usedMcp: boolean;
  toolName: string | null;
  fallbackReason: string | null;
}> {
  const approvedSummary = await loadApprovedArtifactSummary(meta);
  const isFallback = attempt >= 2;
  const isMinimalist = attempt === 3;

  if (fileId === "07") {
    await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在读取所有已生成的前置设计产物...",
    });
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在读取所有已生成的前置设计产物...",
    });

    await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在为您生成 SDD 约束总览...",
    });
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在为您生成 SDD 约束总览...",
    });

    const content = await generateArtifactByLlm(
      meta,
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
    const mcpResult = await tryGenerateWithMcp(meta, fileId, approvedSummary);
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
      meta,
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
    const sections = splitRequirementBySections(meta.requirement);
    if (sections.length <= 1) {
      throw error;
    }
    const chunks: string[] = [];
    for (const section of sections) {
      const patchMeta: FileRunMeta = {
        ...meta,
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

const runMutexMap = new Map<string, Promise<void>>();

export async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const existingLock = runMutexMap.get(runId) || Promise.resolve();
  let release: () => void;
  const newLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  runMutexMap.set(runId, existingLock.then(() => newLock));

  try {
    await existingLock;
    return await fn();
  } finally {
    release!();
    if (runMutexMap.get(runId) === newLock) {
      runMutexMap.delete(runId);
    }
  }
}

export async function filewiseGeneratePendingBaseFiles(meta: FileRunMeta): Promise<FileRunMeta> {
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
    await appendEventLog(meta.workspacePath, meta.runId, "FILE_STAGE_CHANGED", { fileId: file.fileId, status: "GENERATING" });
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
        await validateApiConsistency(meta, file.fileId, generated.content);
        return { file, success: true, generated, attempt };
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        await appendEventLog(meta.workspacePath, meta.runId, "FILE_FAILED", { fileId: file.fileId, attempt, message });
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
      await appendEventLog(freshMeta.workspacePath, freshMeta.runId, "FILE_GENERATED", {
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
  await appendEventLog(meta.workspacePath, meta.runId, "FILE_STAGE_CHANGED", { fileId, status: "GENERATING" });

  let lastError: unknown = null;
  for (const attempt of [1, 2, 3]) {
    try {
      const generated = await runSingleFileGeneration(meta, fileId, attempt);
      if (fileId === "07") {
        await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "正在落盘 SDD 约束总览文件...",
        });
        emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "正在落盘 SDD 约束总览文件...",
        });
      }
      await writeFileBody(meta.workspacePath, meta.runId, fileId, generated.content);
      
      // P3: 一致性校验守卫
      await validateApiConsistency(meta, fileId, generated.content);

      if (fileId === "07") {
        await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "SDD 约束总览生成完毕，准备提交...",
        });
        emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "SDD 约束总览生成完毕，准备提交...",
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
      await appendEventLog(meta.workspacePath, meta.runId, "FILE_GENERATED", {
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
        await appendEventLog(meta.workspacePath, meta.runId, "TASKS_FAILURE_SUMMARY", {
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
      await appendEventLog(meta.workspacePath, meta.runId, "FILE_FAILED", { fileId, attempt, message });
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
  requirement: string;
  llm: unknown;
  workspace: unknown;
  questionnaire: JapState["questionnaire"];
  userAnswers: Record<string, string | string[]>;
  selectedModules?: string[];
}): Promise<FileRunMeta> {
  const workspacePath = resolveWorkspacePath(params.workspace);
  const taskRoot = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks"));
  await ensureOutputDirectoryWritable(taskRoot);
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  await appendEventLog(workspacePath, runId, "RUN_CREATED", {
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
