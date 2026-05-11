import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

import { FILEWISE_STATUS_ORDER, type FileRunMeta } from "../pipeline/stateMachine.js";
import { summarizeText } from "../utils/stringUtils.js";
import { toRunFilePath } from "./metaStore.js";

export async function writeFileBody(
  workspacePath: string,
  runId: string,
  fileId: (typeof FILEWISE_STATUS_ORDER)[number],
  content: string,
): Promise<string> {
  const filePath = toRunFilePath(workspacePath, runId, fileId);
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
  return filePath;
}

export async function readFileBody(
  workspacePath: string,
  runId: string,
  fileId: (typeof FILEWISE_STATUS_ORDER)[number],
): Promise<string> {
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

const approvedSummaryCache = new Map<string, { mtime: number; summary: string }>();

export async function loadApprovedArtifactSummary(meta: FileRunMeta): Promise<string> {
  const records: string[] = [];
  const promises = meta.files.map(async (file) => {
    if (file.status !== "APPROVED") {
      return null;
    }
    const filePath = toRunFilePath(meta.workspacePath, meta.runId, file.fileId);
    try {
      const stat = await fs.stat(filePath);
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

export async function loadAllArtifactContents(meta: FileRunMeta): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};
  for (const fileId of FILEWISE_STATUS_ORDER) {
    try {
      artifacts[fileId] = await readFileBody(meta.workspacePath, meta.runId, fileId);
    } catch {
      artifacts[fileId] = "";
    }
  }
  return artifacts;
}
