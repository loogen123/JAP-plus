import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DocsIndex, KBIndex, KnowledgeBase, RAGDocument } from "./types.js";

export const RAG_DATA_DIR = "data/rag";
const KB_INDEX_FILE = "kb-index.json";

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

async function loadJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function kbIndexPath(): Promise<string> {
  await ensureDir(RAG_DATA_DIR);
  return path.join(RAG_DATA_DIR, KB_INDEX_FILE);
}

async function loadKBIndex(): Promise<KBIndex> {
  const indexPath = await kbIndexPath();
  const index = await loadJsonOr<KBIndex>(indexPath, { version: 1, entries: [] });
  if (index.version !== 1 || !Array.isArray(index.entries)) {
    return { version: 1, entries: [] };
  }
  return index;
}

async function saveKBIndex(index: KBIndex): Promise<void> {
  const indexPath = await kbIndexPath();
  await writeJsonAtomic(indexPath, index);
}

function kbPath(kbId: string): string {
  return path.join(RAG_DATA_DIR, kbId);
}

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  const index = await loadKBIndex();
  return index.entries;
}

export async function createKnowledgeBase(name: string, description: string): Promise<KnowledgeBase> {
  const index = await loadKBIndex();
  const kb: KnowledgeBase = {
    id: randomUUID(),
    name,
    description,
    createdAt: new Date().toISOString(),
    documentCount: 0,
    chunkCount: 0,
  };
  index.entries.push(kb);
  await saveKBIndex(index);
  const root = kbPath(kb.id);
  await ensureDir(root);
  await ensureDir(path.join(root, "originals"));
  await writeJsonAtomic(path.join(root, "kb-meta.json"), kb);
  await writeJsonAtomic(path.join(root, "docs-index.json"), []);
  await writeJsonAtomic(path.join(root, "chunks-index.json"), []);
  return kb;
}

export async function getKnowledgeBase(kbId: string): Promise<KnowledgeBase | null> {
  const index = await loadKBIndex();
  return index.entries.find((item) => item.id === kbId) ?? null;
}

export async function deleteKnowledgeBase(kbId: string): Promise<void> {
  const index = await loadKBIndex();
  const next = index.entries.filter((item) => item.id !== kbId);
  if (next.length === index.entries.length) {
    throw new Error(`knowledge base not found: ${kbId}`);
  }
  await saveKBIndex({ ...index, entries: next });
  await fs.rm(kbPath(kbId), { recursive: true, force: true });
}

export async function updateKBStats(kbId: string, docCount: number, chunkCount: number): Promise<void> {
  const index = await loadKBIndex();
  const target = index.entries.find((item) => item.id === kbId);
  if (!target) {
    return;
  }
  target.documentCount = docCount;
  target.chunkCount = chunkCount;
  await saveKBIndex(index);
  await writeJsonAtomic(path.join(kbPath(kbId), "kb-meta.json"), target);
}

export async function loadDocsIndex(kbId: string): Promise<DocsIndex> {
  return loadJsonOr<DocsIndex>(path.join(kbPath(kbId), "docs-index.json"), []);
}

export async function saveDocsIndex(kbId: string, docs: DocsIndex): Promise<void> {
  await writeJsonAtomic(path.join(kbPath(kbId), "docs-index.json"), docs);
}

export async function addDocumentToIndex(kbId: string, document: RAGDocument): Promise<void> {
  const docs = await loadDocsIndex(kbId);
  docs.push(document);
  await saveDocsIndex(kbId, docs);
}

export async function removeDocumentFromIndex(kbId: string, docId: string): Promise<void> {
  const docs = await loadDocsIndex(kbId);
  await saveDocsIndex(
    kbId,
    docs.filter((item) => item.id !== docId),
  );
}
