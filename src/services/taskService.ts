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
  MODELING_NODE_SYSTEM_PROMPT,
  REVIEW_NODE_SYSTEM_PROMPT,
  SDD_GATE_SYSTEM_PROMPT,
  SDD_NODE_SYSTEM_PROMPT,
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
import { SddConstraintsSchema, type SddConstraints } from "../state/sddConstraints.js";
import { SddGateValidationSchema, type SddGateValidation } from "../state/sddGate.js";
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

const FILEWISE_STATUS_ORDER = ["01", "02", "03", "04", "05", "06", "07", "08"] as const;
export type FileId = (typeof FILEWISE_STATUS_ORDER)[number];
export type ArtifactFileId = FileId;

export type FileSpec = {
  fileId: FileId;
  stage: Exclude<FileRunStage, "DONE">;
  artifactName: string;
  ext: "md" | "yaml" | "html" | "json";
};

const FILE_SPECS: ReadonlyArray<FileSpec> = [
  { fileId: "01", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling01, ext: "md" },
  { fileId: "02", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling02, ext: "md" },
  { fileId: "03", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling03, ext: "md" },
  { fileId: "04", stage: "MODELING", artifactName: ARTIFACT_FILES.modeling04, ext: "yaml" },
  { fileId: "05", stage: "DETAILING", artifactName: ARTIFACT_FILES.detailing05, ext: "md" },
  { fileId: "06", stage: "DETAILING", artifactName: ARTIFACT_FILES.detailing06, ext: "html" },
  { fileId: "07", stage: "DETAILING", artifactName: ARTIFACT_FILES.detailing07, ext: "json" },
  { fileId: "08", stage: "DETAILING", artifactName: ARTIFACT_FILES.sdd08, ext: "md" },
];

const MODELING_FILE_IDS: ArtifactFileId[] = ["01", "02", "03", "04"];
const DETAILING_FILE_IDS: ArtifactFileId[] = ["05", "06", "07", "08"];
const FILEWISE_CONTEXT_LIMIT = 10000;
const FILEWISE_OUTPUT_LIMIT = 16000;


const FILE_TO_ARTIFACT_KEY: Record<ArtifactFileId, string> = {
  "01": ARTIFACT_FILES.modeling01,
  "02": ARTIFACT_FILES.modeling02,
  "03": ARTIFACT_FILES.modeling03,
  "04": ARTIFACT_FILES.modeling04,
  "05": ARTIFACT_FILES.detailing05,
  "06": ARTIFACT_FILES.detailing06,
  "07": ARTIFACT_FILES.detailing07,
  "08": ARTIFACT_FILES.sdd08,
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

export type FileRunMeta = {
  runId: string;
  workflowMode: FileRunMode;
  stage: FileRunStage;
  currentFile: FileId | null;
  requirement: string;
  questionnaire: JapState["questionnaire"];
  userAnswers: Record<string, string | string[]>;
  llm: LlmConfig;
  workspacePath: string;
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
  return ["01", "02", "03", "04", "05", "06", "07"].every((fileId) => {
    const state = meta.files.find((item) => item.fileId === fileId);
    return state?.status === "APPROVED";
  });
}

async function isBaseFilesReadyOnDisk(meta: FileRunMeta): Promise<boolean> {
  if (!isBaseFilesApproved(meta)) {
    return false;
  }
  for (const fileId of ["01", "02", "03", "04", "05", "06", "07"] as const) {
    const filePath = toRunFilePath(meta.workspacePath, meta.runId, fileId);
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
    throw new Error("历史任务未完成01-07审核通过，不能用于SDD生成");
  }
  for (const fileId of ["01", "02", "03", "04", "05", "06", "07"] as const) {
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
  upsertFileState(meta, "08", { status: "PENDING", lastError: null });
  await saveMeta(meta);
  await appendEventLog(meta.workspacePath, meta.runId, "SDD_SOURCE_IMPORTED", {
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
  return ["05", "06", "07", "08"].includes(fileId) ? "DETAILING" : "MODELING";
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
    meta.currentFile !== "08" ||
    meta.files.filter((item) => item.fileId !== "08").every((item) => item.status === "APPROVED");
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
  };
}

export function createInitialFileStates(): FileRunFileState[] {
  const now = nowIso();
  return FILE_SPECS.map((spec) => ({
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

export async function loadApprovedArtifactSummary(meta: FileRunMeta): Promise<string> {
  const records: string[] = [];
  for (const file of meta.files) {
    if (file.status !== "APPROVED") {
      continue;
    }
    const content = await readFileBody(meta.workspacePath, meta.runId, file.fileId);
    if (!content.trim()) {
      continue;
    }
    records.push(`${file.fileId} ${file.artifactName}: ${summarizeText(content)}`);
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
  await writeJson(paths.metaPath, meta);
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
    "05 must be Gherkin acceptance tests.",
    "06 must be complete single-file HTML.",
    "07 must be valid Postman Collection 2.1 JSON.",
    "",
    "Skill context:",
    clampText(skill, 1800),
  ].join("\n");
}

export function buildSddPrompt(requirement: string, approvedSummary: string, evidence: string, qa: string, skill: string): string {
  return [
    `Target file: ${ARTIFACT_FILES.sdd08}`,
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
    "SDD must be engineering-ready and implementation-oriented.",
    "Keep all entity/API/table/state naming consistent with intermediate artifacts.",
    "If a detail is not determined by requirement or intermediate artifacts, use 建议/默认方案/可选项 wording and do not fabricate facts.",
    "You MUST include the appendix JSON constraint block wrapped by markers: <!-- SDD_CONSTRAINTS_JSON_BEGIN --> and <!-- SDD_CONSTRAINTS_JSON_END -->.",
    "",
    "Skill context:",
    clampText(skill, 2500),
  ].join("\n");
}

const SDD_EVIDENCE_FILE_IDS: ReadonlyArray<FileId> = ["01", "02", "03", "04", "05", "06", "07"];

export function extractSddConstraintsFromMarkdown(markdown: string): SddConstraints {
  const markerMatch = markdown.match(
    /<!--\s*SDD_CONSTRAINTS_JSON_BEGIN\s*-->([\s\S]*?)<!--\s*SDD_CONSTRAINTS_JSON_END\s*-->/i,
  );
  if (!markerMatch) {
    throw new Error("SDD constraints JSON block markers not found");
  }
  let jsonText = markerMatch[1]?.trim() ?? "";
  jsonText = jsonText.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  if (!jsonText) {
    throw new Error("SDD constraints JSON block is empty");
  }
  const parsed = JSON.parse(jsonText) as unknown;
  return SddConstraintsSchema.parse(parsed);
}

async function recoverSddConstraintsByLlm(
  meta: FileRunMeta,
  markdown: string,
  parseError: unknown,
): Promise<SddConstraints> {
  const model = createModel(meta, 45000);
  const structured = model.withStructuredOutput(SddConstraintsSchema, { method: "functionCalling" });
  const payload = {
    parseError: parseError instanceof Error ? parseError.message : String(parseError),
    markdown: clampText(markdown, 26000),
  };
  const { result } = await invokeStructuredWithJsonFallback<SddConstraints>({
    invokeStructured: async () =>
      SddConstraintsSchema.parse(
        await structured.invoke([
          new SystemMessage(
            "从给定的SDD markdown中提取并重建约束JSON。只返回符合schema的结构化结果，不要解释。",
          ),
          new HumanMessage(JSON.stringify(payload)),
        ]),
      ),
    invokeFallback: () =>
      model.invoke([
        new SystemMessage(
          "从给定的SDD markdown中提取并重建约束JSON。返回纯JSON对象，字段必须包含version/apis/tables/stateMachines。",
        ),
        new HumanMessage(JSON.stringify(payload)),
      ]),
    safeParse: (value) => SddConstraintsSchema.safeParse(value),
  });
  return SddConstraintsSchema.parse(result);
}

function getSddConstraintsPath(workspacePath: string, runId: string): string {
  const paths = getRunPaths(workspacePath, runId);
  return ensureInsideWorkspace(paths.runDir, path.join(paths.runDir, "sdd.constraints.json"));
}

function getSddValidationPath(workspacePath: string, runId: string): string {
  const paths = getRunPaths(workspacePath, runId);
  return ensureInsideWorkspace(paths.runDir, path.join(paths.runDir, "sdd.validation.json"));
}

function getSddPrecheckPath(workspacePath: string, runId: string): string {
  const paths = getRunPaths(workspacePath, runId);
  return ensureInsideWorkspace(paths.runDir, path.join(paths.runDir, "sdd.precheck.json"));
}

function getSddGateInputPath(workspacePath: string, runId: string): string {
  const paths = getRunPaths(workspacePath, runId);
  return ensureInsideWorkspace(paths.runDir, path.join(paths.runDir, "sdd.gate.input.json"));
}

function getSddGateResultPath(workspacePath: string, runId: string): string {
  const paths = getRunPaths(workspacePath, runId);
  return ensureInsideWorkspace(paths.runDir, path.join(paths.runDir, "sdd.gate.result.json"));
}

export async function readSddGateValidation(workspacePath: string, runId: string): Promise<SddGateValidation | null> {
  try {
    const raw = await fs.readFile(getSddValidationPath(workspacePath, runId), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = SddGateValidationSchema.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data;
  } catch {
    return null;
  }
}

export async function readSddConstraints(workspacePath: string, runId: string): Promise<SddConstraints | null> {
  try {
    const raw = await fs.readFile(getSddConstraintsPath(workspacePath, runId), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = SddConstraintsSchema.safeParse(parsed);
    if (!validated.success) {
      return null;
    }
    return validated.data;
  } catch {
    return null;
  }
}

type SddPrecheckResult = {
  passed: boolean;
  conflicts: Array<{
    category: "api" | "data" | "state" | "other";
    severity: "error" | "warning";
    message: string;
    location: string;
    evidence?: string;
    suggestion?: string;
  }>;
  normalized: {
    apiKeys: string[];
    tableKeys: string[];
    transitionKeys: string[];
  };
};

function normalizeWord(value: string): string {
  const plain = value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!plain) return plain;
  if (plain.endsWith("ies") && plain.length > 3) return `${plain.slice(0, -3)}y`;
  if (plain.endsWith("es") && plain.length > 2) return plain.slice(0, -2);
  if (plain.endsWith("s") && plain.length > 1) return plain.slice(0, -1);
  return plain;
}

function normalizeApiPath(rawPath: string): string {
  const clean = rawPath.trim().replace(/\/+/g, "/").replace(/\/+$/g, "");
  const segs = clean
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (/^\{[^}]+\}$/.test(seg)) return "{id}";
      return normalizeWord(seg);
    });
  return `/${segs.join("/") || ""}`;
}

function parseOpenApiSignatures(openapi: string): Set<string> {
  const lines = openapi.split(/\r?\n/);
  let currentPath = "";
  const out = new Set<string>();
  for (const line of lines) {
    // 匹配 YAML 中的路径，允许前面有缩进，允许根路径 "/"
    const pathMatch = line.match(/^\s*\/([^\s:]*)\s*:\s*$/);
    if (pathMatch) {
      currentPath = `/${pathMatch[1] ?? ""}`;
      continue;
    }
    const methodMatch = line.match(/^\s{2,}(get|post|put|patch|delete)\s*:\s*$/i);
    if (methodMatch && currentPath) {
      const method = methodMatch[1]?.toUpperCase() ?? "GET";
      out.add(`${method} ${normalizeApiPath(currentPath)}`);
    }
  }
  return out;
}

function parseTableColumns(domain: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:`?[a-zA-Z0-9_]+`?\.)?`?([a-zA-Z0-9_]+)`?\s*\(([\s\S]*?)\)/gi;
  for (const match of domain.matchAll(createTable)) {
    const table = normalizeWord(match[1] ?? "");
    if (!table) continue;
    const body = match[2] ?? "";
    const cols = new Set<string>();
    body.split(/\r?\n/).forEach((line) => {
      const colMatch = line.trim().match(/^`?([a-zA-Z0-9_]+)`?\s+[a-zA-Z]/);
      if (!colMatch) return;
      const col = normalizeWord(colMatch[1] ?? "");
      if (col && !["primary", "unique", "key", "index", "constraint", "foreign"].includes(col)) {
        cols.add(col);
      }
    });
    out.set(table, cols);
  }
  return out;
}

function parseStateTransitions(content: string): Set<string> {
  const out = new Set<string>();
  const edgeRegex = /([A-Za-z0-9_]+)\s*--?>\s*([A-Za-z0-9_]+)/g;
  for (const match of content.matchAll(edgeRegex)) {
    const from = normalizeWord(match[1] ?? "");
    const to = normalizeWord(match[2] ?? "");
    if (from && to) out.add(`${from}->${to}`);
  }
  return out;
}

async function runLocalSddPrecheck(meta: FileRunMeta, constraints: SddConstraints): Promise<SddPrecheckResult> {
  const openapi = await readFileBody(meta.workspacePath, meta.runId, "04");
  const domain = await readFileBody(meta.workspacePath, meta.runId, "02");
  const stateMachine = await readFileBody(meta.workspacePath, meta.runId, "03");
  const openapiKeys = parseOpenApiSignatures(openapi);
  const tableMap = parseTableColumns(domain);
  const transitionKeys = parseStateTransitions(stateMachine);
  const conflicts: SddPrecheckResult["conflicts"] = [];

  for (const api of constraints.apis) {
    const method = String(api.method ?? "").toUpperCase();
    const key = `${method} ${normalizeApiPath(String(api.path ?? ""))}`;
    if (!openapiKeys.has(key)) {
      conflicts.push({
        category: "api",
        severity: "error",
        message: `API未命中：${method} ${api.path}`,
        location: "04_api_contract.yaml",
        evidence: key,
        suggestion: "对齐04中的path和method（大小写/尾斜杠/参数占位符已归一化）",
      });
    }
  }

  for (const table of constraints.tables) {
    const tableKey = normalizeWord(table.name);
    const columns = tableMap.get(tableKey);
    if (!columns) {
      conflicts.push({
        category: "data",
        severity: "error",
        message: `数据表未命中：${table.name}`,
        location: "02_domain_model.md",
        evidence: tableKey,
        suggestion: "对齐02中的表名（已做单复数/大小写归一化）",
      });
      continue;
    }
    for (const col of table.requiredColumns ?? []) {
      const colKey = normalizeWord(col);
      if (!columns.has(colKey)) {
        conflicts.push({
          category: "data",
          severity: "warning",
          message: `字段未命中：${table.name}.${col}`,
          location: "02_domain_model.md",
          evidence: `${tableKey}.${colKey}`,
          suggestion: "补充字段或在约束中移除该字段",
        });
      }
    }
  }

  for (const sm of constraints.stateMachines) {
    for (const tr of sm.transitions ?? []) {
      const key = `${normalizeWord(tr.from)}->${normalizeWord(tr.to)}`;
      if (!transitionKeys.has(key)) {
        conflicts.push({
          category: "state",
          severity: "error",
          message: `状态流转未命中：${sm.name} ${tr.from}->${tr.to}`,
          location: "03_state_machine.md",
          evidence: key,
          suggestion: "对齐03中的状态节点与流转边",
        });
      }
    }
  }

  return {
    passed: !conflicts.some((item) => item.severity === "error"),
    conflicts,
    normalized: {
      apiKeys: [...openapiKeys],
      tableKeys: [...tableMap.keys()],
      transitionKeys: [...transitionKeys],
    },
  };
}

async function validateSddGate(
  meta: FileRunMeta,
  constraints: SddConstraints,
  precheck: SddPrecheckResult,
): Promise<{ validation: SddGateValidation; payload: Record<string, unknown> }> {
  const openapi = await readFileBody(meta.workspacePath, meta.runId, "04");
  const domain = await readFileBody(meta.workspacePath, meta.runId, "02");
  const stateMachine = await readFileBody(meta.workspacePath, meta.runId, "03");
  const model = createModel(meta, 45000);
  const structured = model.withStructuredOutput(SddGateValidationSchema, { method: "functionCalling" });

  const payload = {
    constraints,
    precheck,
    artifacts: {
      openapi: clampText(openapi, 22000),
      domainModel: clampText(domain, 22000),
      stateMachine: clampText(stateMachine, 22000),
    },
  };

  const { result, usedFallback } = await invokeStructuredWithJsonFallback<SddGateValidation>({
    invokeStructured: () =>
      structured.invoke([
        new SystemMessage(SDD_GATE_SYSTEM_PROMPT),
        new HumanMessage(JSON.stringify(payload)),
      ]),
    invokeFallback: () =>
      model.invoke([
        new SystemMessage(SDD_GATE_SYSTEM_PROMPT),
        new HumanMessage(JSON.stringify(payload)),
      ]),
    safeParse: (value) => SddGateValidationSchema.safeParse(value),
  });

  const normalized = SddGateValidationSchema.parse(result);
  const conflicts = (normalized.conflicts ?? []).map((conflict) => ({
    category: conflict.category ?? "other",
    severity: conflict.severity ?? "error",
    message: conflict.message,
    location: conflict.location,
    evidence: conflict.evidence,
    suggestion: conflict.suggestion,
  }));
  const mergedConflicts = [
    ...precheck.conflicts.map((conflict) => ({
      category: conflict.category,
      severity: conflict.severity,
      message: conflict.message,
      location: conflict.location,
      evidence: conflict.evidence,
      suggestion: conflict.suggestion,
    })),
    ...conflicts,
  ];
  const hasErrorConflict = mergedConflicts.some((conflict) => conflict.severity === "error");
  const validation: SddGateValidation = {
    ...normalized,
    passed: normalized.passed && !hasErrorConflict,
    conflicts: mergedConflicts,
    meta: {
      ...(normalized.meta ?? {}),
      usedFallback,
    },
  };
  return { validation, payload };
}

async function loadSddEvidence(meta: FileRunMeta): Promise<string> {
  // SDD 作为最终交付物，需要尽可能基于 01~07 的实际产物做一致性约束；因此这里将已生成文件正文按片段注入提示词，减少模型编造与前后矛盾。
  const maxCharsByFile: Partial<Record<FileId, number>> = {
    "01": 5000,
    "02": 8000,
    "03": 6000,
    "04": 12000,
    "05": 5000,
    "06": 5000,
    "07": 5000,
  };

  const blocks: string[] = [];
  for (const fileId of SDD_EVIDENCE_FILE_IDS) {
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

  const sddEvidence = fileId === "08" ? await loadSddEvidence(meta) : "";

  let extraPrompt = "";
  if (minimalist) {
    extraPrompt = "\nMINIMALIST MODE: Output ONLY the core structure, bullet points, and basic outlines. DO NOT include detailed explanations or long texts. Keep it as short as possible while preserving the structure.";
  } else {
    if (fileId === "01") {
      extraPrompt = "\nForce output Mermaid graph TD format. Must include at least 8 core use cases' implementation specs (API sequence, data validation rules, error codes).";
    } else if (fileId === "02") {
      extraPrompt = "\nForce output complete MySQL DDL table creation statements, including PK, FK, indexes (uk_, idx_) and business constraints.";
    } else if (fileId === "04") {
      extraPrompt = "\nForce output OpenAPI 3.0 YAML specification, including $ref definitions for request/response.";
    } else if (fileId === "06") {
      extraPrompt = "\nForce output pure HTML content. DO NOT prefix or suffix the HTML with any markdown text or explanations. Start strictly with <!DOCTYPE html>.";
    }
  }

  const prompt =
    fileId === "08"
      ? buildSddPrompt(requirement, approvedSummary, sddEvidence, qa, skill) + extraPrompt
      : MODELING_FILE_IDS.includes(fileId)
        ? buildModelingPrompt(fileId, requirement, approvedSummary, qa, skill) + extraPrompt
        : buildDetailingPrompt(fileId, requirement, approvedSummary, skill) + extraPrompt;

  const baseSystemPrompt = MODELING_FILE_IDS.includes(fileId)
    ? MODELING_NODE_SYSTEM_PROMPT
    : fileId === "08"
      ? SDD_NODE_SYSTEM_PROMPT
      : DETAILING_NODE_SYSTEM_PROMPT;

  const systemPrompt = baseSystemPrompt + "\n\nYou are generating a single file. Output ONLY the raw markdown/yaml/html/json content. DO NOT wrap it in JSON or any code blocks. No explanations, no filler. Ensure cross-file naming consistency.";

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

  // 针对 HTML 输出可能被 Markdown包裹的进一步清理
  if (fileId === "06" && content.startsWith("<!DOCTYPE html>") && content.includes("```html")) {
    content = content.replace(/```html/g, "").replace(/```/g, "").trim();
  } else if (fileId === "06" && !content.startsWith("<!DOCTYPE html>") && content.includes("<!DOCTYPE html>")) {
    const htmlStart = content.indexOf("<!DOCTYPE html>");
    content = content.slice(htmlStart).replace(/```html/g, "").replace(/```/g, "").trim();
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

async function generateSddConstraintsDraft(
  meta: FileRunMeta,
  approvedSummary: string,
  fallbackContextOnly: boolean,
): Promise<SddConstraints> {
  const model = createModel(meta, fallbackContextOnly ? 35000 : 45000);
  const structured = model.withStructuredOutput(SddConstraintsSchema, { method: "functionCalling" });
  const skill = await loadSkillContext(meta.workspacePath);
  const qa = buildQASnapshot(meta);
  const evidence = await loadSddEvidence(meta);
  const requirement = fallbackContextOnly ? clampText(meta.requirement, 6000) : clampText(meta.requirement, FILEWISE_CONTEXT_LIMIT);

  // --- 新增：硬性提取 02 和 04 的约束列表，喂给大模型防止幻觉遗漏 ---
  const domainModelText = await readFileBody(meta.workspacePath, meta.runId, "02").catch(() => "");
  const openApiText = await readFileBody(meta.workspacePath, meta.runId, "04").catch(() => "");
  
  // 提取表名
  const tableMap = parseTableColumns(domainModelText);
  const hardcodedTables = Array.from(tableMap.keys());
  
  // 提取 API
  const apiSet = parseOpenApiSignatures(openApiText);
  const hardcodedApis = Array.from(apiSet);

  const payload = {
    requirement,
    approvedSummary: clampText(approvedSummary, 12000),
    evidence: clampText(evidence, 36000),
    qa: clampText(qa, 3000),
    skill: clampText(skill, 1800),
    HARD_CONSTRAINTS: {
      MUST_INCLUDE_TABLES: hardcodedTables,
      MUST_INCLUDE_APIS: hardcodedApis
    }
  };

  const systemPrompt = `仅输出SDD约束JSON，字段必须严格符合schema，要求与现有01-07内容一致；不要输出markdown或解释。
非常重要：你必须确保生成的 JSON 中，tables 数组完全包含 payload.HARD_CONSTRAINTS.MUST_INCLUDE_TABLES 里的所有表；apis 数组完全包含 payload.HARD_CONSTRAINTS.MUST_INCLUDE_APIS 里的所有接口！一个都不能少！`;

  const { result } = await invokeStructuredWithJsonFallback<SddConstraints>({
    invokeStructured: async () =>
      SddConstraintsSchema.parse(
        await structured.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(JSON.stringify(payload)),
        ]),
      ),
    invokeFallback: () =>
      model.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(JSON.stringify(payload)),
      ]),
    safeParse: (value) => SddConstraintsSchema.safeParse(value),
  });
  return SddConstraintsSchema.parse(result);
}

function appendConstraintsBlock(markdown: string, constraints: SddConstraints): string {
  const body = markdown.trim();
  const jsonText = JSON.stringify(constraints, null, 2);
  return [
    body,
    "",
    "<!-- SDD_CONSTRAINTS_JSON_BEGIN -->",
    "```json",
    jsonText,
    "```",
    "<!-- SDD_CONSTRAINTS_JSON_END -->",
  ].join("\n");
}

async function generateSddBodyWithConstraints(
  meta: FileRunMeta,
  approvedSummary: string,
  constraints: SddConstraints,
  fallbackContextOnly: boolean,
  minimalist: boolean,
): Promise<string> {
  const skill = await loadSkillContext(meta.workspacePath);
  const qa = buildQASnapshot(meta);
  const evidence = await loadSddEvidence(meta);
  const requirement = fallbackContextOnly ? clampText(meta.requirement, 6000) : clampText(meta.requirement, FILEWISE_CONTEXT_LIMIT);
  const model = createModel(meta, fallbackContextOnly ? 35000 : 45000);
  const extraPrompt = minimalist
    ? "\nMINIMALIST MODE: keep concise sections only."
    : "";
  const prompt =
    [
      buildSddPrompt(requirement, approvedSummary, evidence, qa, skill),
      "",
      "Constraint JSON (SSOT):",
      JSON.stringify(constraints),
      "",
      "必须严格依据Constraint JSON生成SDD正文，正文不要与约束冲突。",
      "正文中不要再解释约束来源。",
    ].join("\n") + extraPrompt;
  const response = await model.invoke([
    new SystemMessage(
      SDD_NODE_SYSTEM_PROMPT +
        "\n\n只输出SDD正文markdown，不要代码块包裹，不要JSON，不要解释。",
    ),
    new HumanMessage(prompt),
  ]);
  const text = typeof response.content === "string" ? response.content.trim() : "";
  if (!text) {
    throw new Error("SDD正文为空");
  }
  return text;
}

type SddGenerationDiagnostics = {
  precheck: SddPrecheckResult;
  gateInput: Record<string, unknown>;
  gateResult: SddGateValidation;
  constraints: SddConstraints;
};

export async function runSingleFileGeneration(meta: FileRunMeta, fileId: FileId, attempt: number): Promise<{
  content: string;
  usedMcp: boolean;
  toolName: string | null;
  fallbackReason: string | null;
  sddDiagnostics?: SddGenerationDiagnostics;
}> {
  const approvedSummary = await loadApprovedArtifactSummary(meta);
  const isFallback = attempt >= 2;
  const isMinimalist = attempt === 3;

  if (fileId === "08") {
    // 增加前端进度提示
    await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在分析前置产物，提取 SDD 硬性约束...",
    });
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在分析前置产物，提取 SDD 硬性约束...",
    });

    const constraints = await generateSddConstraintsDraft(meta, approvedSummary, isFallback);
    const precheck = await runLocalSddPrecheck(meta, constraints);
    
    await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在执行架构一致性预检与门禁校验...",
    });
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在执行架构一致性预检与门禁校验...",
    });
    
    const { validation, payload } = await validateSddGate(meta, constraints, precheck);
    
    // 如果 Gate 校验未通过，将错误降级为 Warning，不抛出异常阻断生成
    if (!validation.passed) {
      const top = (validation.conflicts ?? []).slice(0, 3)
        .map((item) => `${item.message}${item.location ? ` @${item.location}` : ""}`)
        .join("；");
      
      // 记录一个专门的日志事件，提醒用户存在冲突
      await appendEventLog(meta.workspacePath, meta.runId, "SDD_GATE_WARNING", {
        fileId: "08",
        message: `SDD Gate 校验存在冲突（已降级为警告继续生成）：${top || "存在一致性冲突"}`,
      });

      // 我们把 diagnostics 信息依然挂在局部变量里，以便后面的 catch 块或者 finally 块能落盘
      // 但我们不 throw error 了
    }
    
    await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "门禁校验完成，正在基于约束生成 SDD 正文...",
    });
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "门禁校验完成，正在基于约束生成 SDD 正文...",
    });

    const markdown = await generateSddBodyWithConstraints(meta, approvedSummary, constraints, isFallback, isMinimalist);
    return {
      content: appendConstraintsBlock(markdown, constraints),
      usedMcp: false,
      toolName: null,
      fallbackReason: isMinimalist ? "switched to minimalist mode" : (isFallback ? "switched to fallback context" : null),
      sddDiagnostics: {
        constraints,
        precheck,
        gateInput: payload,
        gateResult: validation,
      },
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
  let lastSddDiagnostics: SddGenerationDiagnostics | null = null;
  for (const attempt of [1, 2, 3]) {
    try {
      const generated = await runSingleFileGeneration(meta, fileId, attempt);
      if (fileId === "08") {
        await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "正在落盘 SDD 正文与约束文件...",
        });
        emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "正在落盘 SDD 正文与约束文件...",
        });
      }
      await writeFileBody(meta.workspacePath, meta.runId, fileId, generated.content);
      if (fileId === "08") {
        if (!generated.sddDiagnostics) {
          throw new Error("SDD诊断信息缺失");
        }
        lastSddDiagnostics = generated.sddDiagnostics;
        await writeJson(getSddConstraintsPath(meta.workspacePath, meta.runId), generated.sddDiagnostics.constraints);
        await appendEventLog(meta.workspacePath, meta.runId, "SDD_CONSTRAINTS_EXTRACTED", {
          fileId,
          version: generated.sddDiagnostics.constraints.version,
          apis: generated.sddDiagnostics.constraints.apis.length,
          tables: generated.sddDiagnostics.constraints.tables.length,
          stateMachines: generated.sddDiagnostics.constraints.stateMachines.length,
        });
        await writeJson(getSddValidationPath(meta.workspacePath, meta.runId), generated.sddDiagnostics.gateResult);
        await appendEventLog(meta.workspacePath, meta.runId, "SDD_GATE_VALIDATED", {
          fileId,
          passed: generated.sddDiagnostics.gateResult.passed,
          conflicts: (generated.sddDiagnostics.gateResult.conflicts ?? []).length,
        });
        await appendEventLog(meta.workspacePath, meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "SDD 诊断结果已写入，准备提交08状态...",
        });
        emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
          logType: "INFO",
          title: "系统",
          summary: "SDD 诊断结果已写入，准备提交08状态...",
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
      const sddDiagnostics = (error as { sddDiagnostics?: SddGenerationDiagnostics }).sddDiagnostics ?? null;
      if (fileId === "08" && sddDiagnostics) {
        lastSddDiagnostics = sddDiagnostics;
        await writeJson(getSddPrecheckPath(meta.workspacePath, meta.runId), sddDiagnostics.precheck);
        await writeJson(getSddGateInputPath(meta.workspacePath, meta.runId), sddDiagnostics.gateInput);
        await writeJson(getSddGateResultPath(meta.workspacePath, meta.runId), sddDiagnostics.gateResult);
        const top3 = (sddDiagnostics.gateResult.conflicts ?? [])
          .slice(0, 3)
          .map((item) => `${item.message}${item.location ? ` @${item.location}` : ""}`)
          .join("；");
        const suggested = (sddDiagnostics.gateResult.conflicts ?? [])
          .slice(0, 3)
          .map((item) => item.suggestion)
          .filter(Boolean)
          .join("；");
        await appendEventLog(meta.workspacePath, meta.runId, "SDD_FAILURE_SUMMARY", {
          fileId,
          top3: top3 || "无",
          suggestion: suggested || "请先修正01-07后重试",
        });
      } else if (fileId === "08") {
        const message = error instanceof Error ? error.message : String(error);
        const lowered = message.toLowerCase();
        const networkLike =
          lowered.includes("connection error") ||
          lowered.includes("timeout") ||
          lowered.includes("timed out") ||
          lowered.includes("econn") ||
          lowered.includes("socket hang up");
        await appendEventLog(meta.workspacePath, meta.runId, "SDD_FAILURE_SUMMARY", {
          fileId,
          top3: message || "SDD生成失败",
          suggestion: networkLike
            ? "检查LLM baseUrl/apiKey与网络连通性后重试"
            : "查看FILE_FAILED与LLM响应详情后重试",
        });
      }
      const message = error instanceof Error ? error.message : String(error);
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
    files: createInitialFileStates(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
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
