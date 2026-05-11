import { ARTIFACT_FILES } from "../constants/domainConstants.js";
import type { JapState } from "../state/japState.js";

export type FileRunStatus = "PENDING" | "GENERATING" | "GENERATED" | "REVIEWING" | "APPROVED" | "REJECTED" | "FAILED";
export type FileRunStage = "MODELING" | "REVIEW" | "DETAILING" | "DONE";
export type FileRunMode = "legacy" | "filewise";

export const FILEWISE_STATUS_ORDER = ["01", "02", "03", "04", "05", "06", "07"] as const;
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

export type FileRunRuntimePaths = {
  runDir: string;
  metaPath: string;
  eventsPath: string;
};

export type FileRunMeta = {
  runId: string;
  workflowMode: FileRunMode;
  stage: FileRunStage;
  currentFile: FileId | null;
  requirement: string;
  questionnaire: JapState["questionnaire"];
  userAnswers: Record<string, string | string[]>;
  llm: {
    baseUrl: string;
    apiKey: string;
    modelName: string;
  };
  ragKbId?: string;
  workspacePath: string;
  selectedModules?: string[];
  status: "RUNNING" | "DONE" | "FAILED";
  files: FileRunFileState[];
  createdAt: string;
  updatedAt: string;
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
