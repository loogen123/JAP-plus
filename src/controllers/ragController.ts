import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import {
  RAGService,
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  loadDocsIndex,
  RAG_DATA_DIR,
} from "../rag/index.js";

const ragService = new RAGService();

async function tryReadOriginalDocument(doc: { filePath: string; fileType: string }): Promise<string | null> {
  if (!doc.filePath) {
    return null;
  }
  if (doc.fileType === "md" || doc.fileType === "txt" || doc.fileType === "code") {
    return fs.readFile(doc.filePath, "utf-8");
  }
  return null;
}

function getEmbeddingConfig(): { baseURL: string; apiKey: string; model?: string } {
  return {
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  };
}

async function normalizeUploadFiles(
  kbId: string,
  files: unknown[],
): Promise<{ filePath: string; fileName: string }[]> {
  const originalsDir = path.resolve(RAG_DATA_DIR, kbId, "originals");
  await fs.mkdir(originalsDir, { recursive: true });
  const normalized: { filePath: string; fileName: string }[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") {
      continue;
    }
    const row = file as {
      filePath?: unknown;
      fileName?: unknown;
      content?: unknown;
      contentBase64?: unknown;
      encoding?: unknown;
    };
    const fileName = typeof row.fileName === "string" ? row.fileName.trim() : "";
    if (!fileName) {
      continue;
    }
    if (typeof row.content === "string") {
      const targetPath = path.join(originalsDir, `${randomUUID()}-${fileName}`);
      await fs.writeFile(targetPath, row.content, "utf-8");
      normalized.push({ fileName, filePath: targetPath });
      continue;
    }
    if (
      typeof row.contentBase64 === "string" &&
      row.contentBase64.length > 0 &&
      row.encoding === "base64"
    ) {
      const targetPath = path.join(originalsDir, `${randomUUID()}-${fileName}`);
      const binary = Buffer.from(row.contentBase64, "base64");
      await fs.writeFile(targetPath, binary);
      normalized.push({ fileName, filePath: targetPath });
      continue;
    }
    if (typeof row.filePath === "string" && row.filePath.trim()) {
      normalized.push({ fileName, filePath: row.filePath.trim() });
    }
  }
  return normalized;
}

export class RAGController {
  async listKBs(_req: Request, res: Response): Promise<void> {
    const data = await listKnowledgeBases();
    res.json({ code: 0, data });
  }

  async createKB(req: Request, res: Response): Promise<void> {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description : "";
    if (!name) {
      res.status(400).json({ code: 1, message: "name is required" });
      return;
    }
    const data = await createKnowledgeBase(name, description);
    res.json({ code: 0, data });
  }

  async deleteKB(req: Request, res: Response): Promise<void> {
    const kbId = String(req.params.kbId ?? "").trim();
    try {
      await deleteKnowledgeBase(kbId);
      ragService.clearCache(kbId);
      res.json({ code: 0, message: "deleted" });
    } catch {
      res.status(404).json({ code: 1, message: "not found" });
    }
  }

  async getKB(req: Request, res: Response): Promise<void> {
    const kbId = String(req.params.kbId ?? "").trim();
    const kb = await getKnowledgeBase(kbId);
    if (!kb) {
      res.status(404).json({ code: 1, message: "not found" });
      return;
    }
    const documents = await loadDocsIndex(kbId);
    res.json({ code: 0, data: { ...kb, documents } });
  }

  async uploadDocs(req: Request, res: Response): Promise<void> {
    const kbId = String(req.params.kbId ?? "").trim();
    const kb = await getKnowledgeBase(kbId);
    if (!kb) {
      res.status(404).json({ code: 1, message: "knowledge base not found" });
      return;
    }
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const normalizedFiles = await normalizeUploadFiles(kbId, files);
    if (normalizedFiles.length === 0) {
      res.status(400).json({ code: 1, message: "files array required" });
      return;
    }
    const data = await ragService.ingestFiles(kbId, normalizedFiles, getEmbeddingConfig());
    res.json({ code: 0, data });
  }

  async deleteDoc(req: Request, res: Response): Promise<void> {
    const kbId = String(req.params.kbId ?? "").trim();
    const docId = String(req.params.docId ?? "").trim();
    try {
      await ragService.removeDocument(kbId, docId);
      res.json({ code: 0, message: "deleted" });
    } catch {
      res.status(404).json({ code: 1, message: "not found" });
    }
  }

  async getDocContent(req: Request, res: Response): Promise<void> {
    const kbId = String(req.params.kbId ?? "").trim();
    const docId = String(req.params.docId ?? "").trim();
    const kb = await getKnowledgeBase(kbId);
    if (!kb) {
      res.status(404).json({ code: 1, message: "not found" });
      return;
    }
    const docs = await loadDocsIndex(kbId);
    const doc = docs.find((item) => item.id === docId);
    if (!doc) {
      res.status(404).json({ code: 1, message: "document not found" });
      return;
    }
    try {
      const original = await tryReadOriginalDocument(doc);
      if (typeof original === "string" && original.trim()) {
        res.json({ code: 0, data: { fileName: doc.fileName, content: original } });
        return;
      }
      const chunksPath = path.resolve(RAG_DATA_DIR, kbId, "chunks-index.json");
      const raw = await fs.readFile(chunksPath, "utf-8");
      const chunks = (JSON.parse(raw) as Array<{ docId?: unknown; content?: unknown; metadata?: unknown }>)
        .filter((row) => row && String(row.docId ?? "") === docId)
        .map((row) => ({
          content: typeof row.content === "string" ? row.content : "",
          chunkIndex:
            row.metadata && typeof row.metadata === "object" && typeof (row.metadata as any).chunkIndex === "number"
              ? (row.metadata as any).chunkIndex
              : 0,
        }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const content = chunks.map((c) => c.content).filter(Boolean).join("\n\n");
      res.json({ code: 0, data: { fileName: doc.fileName, content } });
    } catch (error) {
      res.status(500).json({ code: 1, message: String(error) });
    }
  }

  async queryKB(req: Request, res: Response): Promise<void> {
    const kbId = String(req.params.kbId ?? "").trim();
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      res.status(400).json({ code: 1, message: "query is required" });
      return;
    }
    const kb = await getKnowledgeBase(kbId);
    if (!kb) {
      res.status(404).json({ code: 1, message: "not found" });
      return;
    }
    const data = await ragService.retrieve(query, kbId, getEmbeddingConfig());
    res.json({ code: 0, data });
  }
}
