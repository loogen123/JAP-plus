import path from "node:path";
import type { ApiConfig, RetrievalResult, RetrieveOptions } from "../types.js";
import { embedChunks } from "../embedding/index.js";
import { createVectorStore, type VectorStore } from "../vectorStore/index.js";
import { keywordSearch } from "./hybridSearch.js";
import { mmrRerank, rrfFuse } from "./reranker.js";

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0;
const RAG_DATA_DIR = "data/rag";

const storeCache = new Map<string, VectorStore>();

async function getStore(kbId: string): Promise<VectorStore> {
  const cached = storeCache.get(kbId);
  if (cached) {
    return cached;
  }
  const kbPath = path.resolve(RAG_DATA_DIR, kbId);
  const store = await createVectorStore(kbPath);
  storeCache.set(kbId, store);
  return store;
}

export async function retrieve(
  query: string,
  kbId: string,
  apiConfig: ApiConfig,
  options?: RetrieveOptions,
): Promise<RetrievalResult[]> {
  const topK = options?.topK ?? DEFAULT_TOP_K;
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const store = await getStore(kbId);
  const stats = store.getStats();
  if (stats.chunkCount === 0) {
    return [];
  }
  const queryEmbedding = await embedChunks([{ id: "__query__", content: query }], apiConfig);
  const queryVector = queryEmbedding.get("__query__");
  if (!queryVector) {
    return [];
  }
  const semanticResults = await store.search(queryVector, topK * 3);
  const allChunks = await store.listChunks();
  const chunkMap = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
  const keywordRows = keywordSearch(
    query,
    allChunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
    topK * 3,
  );
  const keywordResults: RetrievalResult[] = keywordRows
    .map((row) => {
      const chunk = chunkMap.get(row.id);
      if (!chunk) {
        return null;
      }
      const section = chunk.metadata.sectionTitle ? ` > ${chunk.metadata.sectionTitle}` : "";
      return {
        chunk,
        score: row.score,
        source: `${chunk.metadata.docFileName}${section}`,
      } satisfies RetrievalResult;
    })
    .filter((item): item is RetrievalResult => item !== null);

  const fused = rrfFuse(semanticResults, keywordResults)
    .filter((item) => item.score >= minScore)
    .slice(0, topK * 2);

  return mmrRerank(fused, topK, 0.3).slice(0, topK);
}

export function clearStoreCache(kbId?: string): void {
  if (kbId) {
    storeCache.delete(kbId);
  } else {
    storeCache.clear();
  }
}
