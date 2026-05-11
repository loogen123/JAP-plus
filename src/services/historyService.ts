import fs from "node:fs/promises";
import path from "node:path";
import { cleanupSummaryText } from "../utils/stringUtils.js";

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
    const bytesToRead = Math.min(stat.size, maxChars * 4);
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

async function readRequirementText(filePath: string): Promise<string> {
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
