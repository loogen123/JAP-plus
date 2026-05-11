import fs from "node:fs/promises";

import { getRunPaths } from "./metaStore.js";

export type RunEventRecord = {
  at: string;
  runId: string;
  type: string;
  [key: string]: unknown;
};

export async function appendEventLog(workspacePath: string, runId: string, type: string, data: Record<string, unknown>): Promise<void> {
  const paths = getRunPaths(workspacePath, runId);
  await fs.mkdir(paths.runDir, { recursive: true });
  await fs.appendFile(
    paths.eventsPath,
    JSON.stringify({ at: new Date().toISOString(), runId, type, ...data }) + "\n",
    "utf-8",
  );
}

export async function readRunEventsTail(
  workspacePath: string,
  runId: string,
  tail: number,
  cursor: number = 0,
): Promise<{ events: RunEventRecord[]; nextCursor: number }> {
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
        at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
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
