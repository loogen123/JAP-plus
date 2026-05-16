import { randomUUID } from "node:crypto";
import path from "node:path";
import { ingestDocuments } from "./ingestion/index.js";
import { chunkText } from "./chunking/index.js";
import { embedChunks } from "./embedding/index.js";
import { createVectorStore, type VectorStore } from "./vectorStore/index.js";
import { buildRAGPrompt } from "./injection/index.js";
import {
  clearStoreCache,
  mergeRetrievalResults,
  retrieve as retrieveCore,
} from "./retrieval/index.js";
import {
  addDocumentToIndex,
  loadDocsIndex,
  removeDocumentFromIndex,
  updateKBStats,
  listKnowledgeBases,
  createKnowledgeBase,
  getKnowledgeBase,
  deleteKnowledgeBase,
} from "./kbManager.js";
import type { ApiConfig, Chunk, RAGContext, RetrievalResult, RetrieveOptions } from "./types.js";

export const RAG_DATA_DIR = "data/rag";
const EMPTY_VECTOR_DIM = 1536;

export type {
  KnowledgeBase,
  RAGDocument,
  Chunk,
  ChunkMeta,
  RetrievalResult,
  RAGContext,
  ApiConfig,
  ChunkOptions,
  RetrieveOptions,
  DocFileType,
} from "./types.js";

export {
  listKnowledgeBases,
  createKnowledgeBase,
  getKnowledgeBase,
  deleteKnowledgeBase,
  loadDocsIndex,
  addDocumentToIndex,
  removeDocumentFromIndex,
  updateKBStats,
} from "./kbManager.js";

export class RAGService {
  private readonly storeCache = new Map<string, VectorStore>();

  private async getStore(kbId: string): Promise<VectorStore> {
    const cached = this.storeCache.get(kbId);
    if (cached) {
      return cached;
    }
    const store = await createVectorStore(path.resolve(RAG_DATA_DIR, kbId));
    this.storeCache.set(kbId, store);
    return store;
  }

  async ingestFiles(
    kbId: string,
    files: { filePath: string; fileName: string }[],
    apiConfig: ApiConfig,
  ): Promise<{ success: number; errors: string[] }> {
    const errors: string[] = [];
    let success = 0;
    const ingestResults = await ingestDocuments(kbId, files);
    for (const result of ingestResults) {
      if (result.error) {
        errors.push(`${result.document.fileName}: ${result.error}`);
        continue;
      }
      if (!result.text.trim()) {
        errors.push(`${result.document.fileName}: empty content`);
        continue;
      }
      const chunkDrafts = chunkText(result.text, result.document.fileName);
      if (chunkDrafts.length === 0) {
        errors.push(`${result.document.fileName}: no chunks`);
        continue;
      }
      const chunks: Chunk[] = chunkDrafts.map((draft) => ({
        id: randomUUID(),
        docId: result.document.id,
        kbId,
        content: draft.content,
        embedding: [],
        metadata: draft.metadata,
      }));
      const embeddingMap = await embedChunks(
        chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
        apiConfig,
      );
      for (const chunk of chunks) {
        chunk.embedding = embeddingMap.get(chunk.id) ?? new Array(EMPTY_VECTOR_DIM).fill(0);
      }
      const store = await this.getStore(kbId);
      await store.addVectors(chunks);
      result.document.chunkIds = chunks.map((chunk) => chunk.id);
      await addDocumentToIndex(kbId, result.document);
      success += 1;
    }
    const docs = await loadDocsIndex(kbId);
    const store = await this.getStore(kbId);
    await updateKBStats(kbId, docs.length, store.getStats().chunkCount);
    return { success, errors };
  }

  async retrieveAndBuild(
    query: string,
    kbId: string,
    apiConfig: ApiConfig,
    kbName: string,
    options?: RetrieveOptions & { maxPromptTokens?: number },
  ): Promise<RAGContext> {
    const results = (await retrieveCore(query, kbId, apiConfig, options)).map((item) => ({
      ...item,
      kbId,
      kbName,
    }));
    const injectedPrompt = buildRAGPrompt(results, options?.maxPromptTokens);
    return { query, results, injectedPrompt };
  }

  async retrieve(
    query: string,
    kbId: string,
    apiConfig: ApiConfig,
    options?: RetrieveOptions,
  ): Promise<RetrievalResult[]> {
    const kb = await getKnowledgeBase(kbId);
    const kbName = kb?.name ?? "";
    return (await retrieveCore(query, kbId, apiConfig, options)).map((item) => ({
      ...item,
      kbId,
      kbName,
    }));
  }

  async retrieveAcrossKnowledgeBases(
    query: string,
    kbIds: string[],
    apiConfig: ApiConfig,
    options?: RetrieveOptions,
  ): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? 5;
    const groups = await Promise.all(
      kbIds.map(async (kbId) => {
        try {
          const kb = await getKnowledgeBase(kbId);
          if (!kb) {
            return [];
          }
          const results = await retrieveCore(query, kbId, apiConfig, options);
          return results.map((item) => ({
            ...item,
            kbId,
            kbName: kb.name,
          }));
        } catch {
          return [];
        }
      }),
    );
    return mergeRetrievalResults(groups, topK);
  }

  async retrieveAndBuildAcrossKnowledgeBases(
    query: string,
    kbIds: string[],
    apiConfig: ApiConfig,
    options?: RetrieveOptions & { maxPromptTokens?: number },
  ): Promise<RAGContext> {
    const results = await this.retrieveAcrossKnowledgeBases(query, kbIds, apiConfig, options);
    const injectedPrompt = buildRAGPrompt(results, options?.maxPromptTokens);
    return { query, results, injectedPrompt };
  }

  async removeDocument(kbId: string, docId: string): Promise<void> {
    const docs = await loadDocsIndex(kbId);
    const target = docs.find((item) => item.id === docId);
    if (!target) {
      throw new Error("document not found");
    }
    const store = await this.getStore(kbId);
    await store.deleteByDocId(docId);
    await removeDocumentFromIndex(kbId, docId);
    const remained = await loadDocsIndex(kbId);
    await updateKBStats(kbId, remained.length, store.getStats().chunkCount);
  }

  clearCache(kbId?: string): void {
    if (kbId) {
      this.storeCache.delete(kbId);
    } else {
      this.storeCache.clear();
    }
    clearStoreCache(kbId);
  }
}
