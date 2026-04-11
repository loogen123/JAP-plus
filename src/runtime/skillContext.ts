import { readFile } from "node:fs/promises";
import path from "node:path";

type SkillCacheValue = {
  content: string;
  expiresAt: number;
};

const skillCache = new Map<string, SkillCacheValue>();
const DEFAULT_TTL_MS = 300000;

export async function loadSkillContext(
  workspacePath?: string | null,
  ttlMs = DEFAULT_TTL_MS,
): Promise<string> {
  const root = path.resolve(workspacePath || process.cwd());
  const cacheKey = root;
  const now = Date.now();
  const cached = skillCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.content;
  }
  const skillFile = path.join(root, ".jap-skills.md");
  try {
    const raw = await readFile(skillFile, "utf-8");
    const content = raw.trim();
    const finalContent = content ? `\n[SkillRules]\n${content}\n[/SkillRules]\n` : "";
    skillCache.set(cacheKey, {
      content: finalContent,
      expiresAt: now + ttlMs,
    });
    return finalContent;
  } catch {
    skillCache.set(cacheKey, {
      content: "",
      expiresAt: now + ttlMs,
    });
    return "";
  }
}

