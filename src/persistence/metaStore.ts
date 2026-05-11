import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  deriveStageFromCurrentFile,
  getFileSpec,
  resolveCurrentFile,
  type FileId,
  type FileRunMeta,
  type FileRunRuntimePaths,
} from "../pipeline/stateMachine.js";

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

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

export function getRunPaths(workspacePath: string, runId: string): FileRunRuntimePaths {
  const runDir = ensureInsideWorkspace(workspacePath, path.join(workspacePath, "tasks", runId));
  return {
    runDir,
    metaPath: ensureInsideWorkspace(runDir, path.join(runDir, "meta.json")),
    eventsPath: ensureInsideWorkspace(runDir, path.join(runDir, "events.log")),
  };
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
  meta.updatedAt = new Date().toISOString();

  const metaToSave = JSON.parse(JSON.stringify(meta));
  if (metaToSave.llm && metaToSave.llm.apiKey) {
    metaToSave.llm.apiKey = "***";
  }
  const tmpPath = `${paths.metaPath}.tmp-${randomUUID()}`;
  await writeJson(tmpPath, metaToSave);
  await fs.rename(tmpPath, paths.metaPath);
}
