import type { Express } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { ARTIFACT_FILES } from "../constants/domainConstants.js";

import {
  DETAILING_NODE_SYSTEM_PROMPT,
  MODELING_NODE_SYSTEM_PROMPT,
  REVIEW_NODE_SYSTEM_PROMPT,
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
import { JapMcpClient } from "../tools/mcpClient.js";


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

function resolveOutputPath(input: unknown): string {
  if (isWorkspaceConfig(input) && input.path.trim()) {
    return path.resolve(input.path.trim());
  }
  return path.resolve(process.cwd(), "output");
}

async function ensureOutputDirectoryWritable(outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  const probeFile = path.join(outputDir, `.jap-probe-${randomUUID()}.tmp`);
  await fs.writeFile(probeFile, "ok", "utf-8");
  await fs.unlink(probeFile);
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



type FileRunStatus = "PENDING" | "GENERATING" | "GENERATED" | "REVIEWING" | "APPROVED" | "REJECTED" | "FAILED";
type FileRunStage = "MODELING" | "REVIEW" | "DETAILING" | "DONE";
type FileRunMode = "legacy" | "filewise";

const FILEWISE_STATUS_ORDER = ["01", "02", "03", "04", "05", "06", "07"] as const;
type FileId = (typeof FILEWISE_STATUS_ORDER)[number];
type ArtifactFileId = FileId;

type FileSpec = {
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
  "07": ARTIFACT_FILES.detailing07,
};

type FileRunFileState = {
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
  status: "RUNNING" | "DONE" | "FAILED";
  files: FileRunFileState[];
  createdAt: string;
  updatedAt: string;
};



type FileRunRuntimePaths = {
  runDir: string;
  metaPath: string;
  eventsPath: string;
};

type FileRuntimeRecord = {
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

function nowIso(): string {
  return new Date().toISOString();
}

function getFileSpec(fileId: FileId): FileSpec {
  const spec = FILE_SPECS.find((item) => item.fileId === fileId);
  if (!spec) {
    throw new Error(`Unknown fileId: ${fileId}`);
  }
  return spec;
}

function getRunPaths(workspacePath: string, runId: string): FileRunRuntimePaths {
  const runDir = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks", runId));
  return {
    runDir,
    metaPath: ensureInsideWorkspace(runDir, path.join(runDir, "meta.json")),
    eventsPath: ensureInsideWorkspace(runDir, path.join(runDir, "events.log")),
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function appendEventLog(workspacePath: string, runId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const paths = getRunPaths(workspacePath, runId);
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.appendFile(
    paths.eventsPath,
    JSON.stringify({ at: nowIso(), runId, type, ...data }) + "\n",
    "utf-8",
  );
}

function deriveStageFromCurrentFile(fileId: FileId | null): FileRunStage {
  if (!fileId) {
    return "DONE";
  }
  return ["05", "06", "07"].includes(fileId) ? "DETAILING" : "MODELING";
}

function resolveCurrentFile(files: FileRunFileState[]): FileId | null {
  for (const id of FILEWISE_STATUS_ORDER) {
    const found = files.find((item) => item.fileId === id);
    if (found && found.status !== "APPROVED") {
      return id;
    }
  }
  return null;
}

function getFileRuntimeRecord(meta: FileRunMeta): FileRuntimeRecord {
  const current = meta.currentFile ? meta.files.find((item) => item.fileId === meta.currentFile) ?? null : null;
  const currentStatus = current?.status ?? null;
  return {
    runId: meta.runId,
    stage: meta.stage,
    currentFile: meta.currentFile,
    files: meta.files,
    actions: {
      canGenerateNext: currentStatus === "PENDING" || currentStatus === "FAILED" || currentStatus === "REJECTED",
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

function toFileStatusResponse(meta: FileRunMeta, workspacePath: string): Record<string, unknown> {
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

function createInitialFileStates(): FileRunFileState[] {
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

function ensureValidFileId(value: string): FileId {
  if (FILEWISE_STATUS_ORDER.includes(value as FileId)) {
    return value as FileId;
  }
  throw new Error("invalid fileId");
}

function splitRequirementBySections(requirement: string): string[] {
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

function clampText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}\n\n[truncated]`;
}

function summarizeText(input: string): string {
  const cleaned = input.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 240) {
    return cleaned;
  }
  return `${cleaned.slice(0, 140)} ... ${cleaned.slice(-80)}`;
}

async function loadApprovedArtifactSummary(meta: FileRunMeta): Promise<string> {
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

async function ensureRunDirectories(workspacePath: string, runId: string): Promise<FileRunRuntimePaths> {
  const paths = getRunPaths(workspacePath, runId);
  await fs.mkdir(paths.runDir, { recursive: true });
  return paths;
}

function toRunFilePath(workspacePath: string, runId: string, fileId: FileId): string {
  const spec = getFileSpec(fileId);
  const paths = getRunPaths(workspacePath, runId);
  return ensureInsideWorkspace(paths.runDir, path.join(paths.runDir, spec.artifactName));
}

async function readMeta(workspacePath: string, runId: string): Promise<FileRunMeta> {
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

async function saveMeta(meta: FileRunMeta): Promise<void> {
  const paths = await ensureRunDirectories(meta.workspacePath, meta.runId);
  meta.currentFile = resolveCurrentFile(meta.files);
  meta.stage = deriveStageFromCurrentFile(meta.currentFile);
  if (!meta.currentFile) {
    meta.status = "DONE";
  }
  meta.updatedAt = nowIso();
  await writeJson(paths.metaPath, meta);
}

async function writeFileBody(
  workspacePath: string,
  runId: string,
  fileId: FileId,
  content: string,
): Promise<string> {
  const filePath = toRunFilePath(workspacePath, runId, fileId);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

async function readFileBody(workspacePath: string, runId: string, fileId: FileId): Promise<string> {
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

function upsertFileState(meta: FileRunMeta, fileId: FileId, patch: Partial<FileRunFileState>): void {
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



function buildQASnapshot(meta: FileRunMeta): string {
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



function createModel(meta: FileRunMeta, timeout: number): ChatOpenAI {
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

function buildModelingPrompt(fileId: ArtifactFileId, requirement: string, approvedSummary: string, qa: string, skill: string): string {
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

function buildDetailingPrompt(fileId: ArtifactFileId, requirement: string, approvedSummary: string, skill: string): string {
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



async function generateArtifactByLlm(
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
    MODELING_FILE_IDS.includes(fileId)
      ? buildModelingPrompt(fileId, requirement, approvedSummary, qa, skill) + extraPrompt
      : buildDetailingPrompt(fileId, requirement, approvedSummary, skill) + extraPrompt;

  const baseSystemPrompt = MODELING_FILE_IDS.includes(fileId)
    ? MODELING_NODE_SYSTEM_PROMPT
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

async function tryGenerateWithMcp(
  meta: FileRunMeta,
  fileId: FileId,
  approvedSummary: string,
): Promise<{ content: string; toolName: string } | null> {
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

async function runSingleFileGeneration(meta: FileRunMeta, fileId: FileId, attempt: number): Promise<{
  content: string;
  usedMcp: boolean;
  toolName: string | null;
  fallbackReason: string | null;
}> {
  const approvedSummary = await loadApprovedArtifactSummary(meta);
  
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
  const isFallback = attempt >= 2;
  const isMinimalist = attempt === 3;

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

async function filewiseGenerateCurrent(meta: FileRunMeta): Promise<FileRunMeta> {
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
      await writeFileBody(meta.workspacePath, meta.runId, fileId, generated.content);

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

async function createFilewiseRun(params: {
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



  app.post("/api/v1/tasks/filewise/start", async (req, res) => {
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
  });

  app.get("/api/v1/tasks/filewise/:runId", async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.query.workspace ?? req.query.workspacePath ?? req.body?.workspace);
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      const meta = await readMeta(workspacePath, runId);
      const runtime = getFileRuntimeRecord(meta);
      const currentBody = runtime.currentFile
        ? await readFileBody(workspacePath, runId, runtime.currentFile)
        : "";
      res.json({
        ...toFileStatusResponse(meta, workspacePath),
        currentFileContent: currentBody,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(404).json({ message });
    }
  });

  app.post("/api/v1/tasks/filewise/:runId/generate-next", async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    if (!runId) {
      res.status(400).json({ message: "runId is required" });
      return;
    }
    try {
      const meta = await readMeta(workspacePath, runId);
      const runtime = getFileRuntimeRecord(meta);
      if (!runtime.actions.canGenerateNext || !meta.currentFile) {
        res.status(409).json({ message: "no file is ready for generation", ...toFileStatusResponse(meta, workspacePath) });
        return;
      }
      await filewiseGenerateCurrent(meta);
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  });

  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/approve", async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
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
      await appendEventLog(workspacePath, runId, "FILE_APPROVED", { fileId });
      await appendEventLog(workspacePath, runId, "RUN_POINTER_MOVED", {
        currentFile: meta.currentFile,
        stage: meta.stage,
      });
      res.json(toFileStatusResponse(meta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  });

  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/reject", async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    const reason = String(req.body?.reason ?? "").trim() || "rejected by user";
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
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
      res.json(toFileStatusResponse(meta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  });

  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/regenerate", async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
      const meta = await readMeta(workspacePath, runId);
      if (meta.currentFile !== fileId) {
        res.status(409).json({ message: "only current file can be regenerated" });
        return;
      }
      upsertFileState(meta, fileId, { status: "PENDING", lastError: null });
      await saveMeta(meta);
      await appendEventLog(workspacePath, runId, "FILE_REGENERATE_REQUESTED", { fileId });
      await filewiseGenerateCurrent(meta);
      const refreshed = await readMeta(workspacePath, runId);
      res.json(toFileStatusResponse(refreshed, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  });

  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/save-edit", async (req, res) => {
    const runId = String(req.params.runId ?? "").trim();
    const workspacePath = resolveWorkspacePath(req.body?.workspace ?? req.query.workspace ?? req.query.workspacePath);
    const content = String(req.body?.content ?? "");
    if (!content.trim()) {
      res.status(400).json({ message: "content is required" });
      return;
    }
    try {
      const fileId = ensureValidFileId(String(req.params.fileId ?? "").trim());
      const meta = await readMeta(workspacePath, runId);
      if (meta.currentFile !== fileId) {
        res.status(409).json({ message: "only current file can be edited in-run" });
        return;
      }
      await writeFileBody(workspacePath, runId, fileId, content);

      upsertFileState(meta, fileId, { status: "GENERATED", lastError: null });
      await saveMeta(meta);
      await appendEventLog(workspacePath, runId, "FILE_EDIT_SAVED", { fileId });
      res.json(toFileStatusResponse(meta, workspacePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  });
}
