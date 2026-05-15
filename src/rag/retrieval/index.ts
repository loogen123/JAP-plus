import path from "node:path";
import type { ApiConfig, RetrievalResult, RetrieveOptions } from "../types.js";
import { cosineSimilarity, embedChunks, embedWithHashing, tokenize } from "../embedding/index.js";
import { createVectorStore, type VectorStore } from "../vectorStore/index.js";
import { keywordSearch } from "./hybridSearch.js";
import { applySoftDiversification, mmrRerank, rrfFuse } from "./reranker.js";

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0;
const DEFAULT_CANDIDATE_POOL_MULTIPLIER = 8;
const DEFAULT_CANDIDATE_POOL_MIN = 20;
const DEFAULT_QUERY_REWRITE_LIMIT = 3;
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

function hasConsistentEmbeddingDimensions(chunks: { embedding: number[] }[]): number | null {
  let dimension: number | null = null;
  for (const chunk of chunks) {
    if (!Array.isArray(chunk.embedding) || chunk.embedding.length === 0) {
      return null;
    }
    if (dimension === null) {
      dimension = chunk.embedding.length;
      continue;
    }
    if (dimension !== chunk.embedding.length) {
      return null;
    }
  }
  return dimension;
}

async function localSemanticSearch(
  query: string,
  chunks: Awaited<ReturnType<VectorStore["listChunks"]>>,
  topK: number,
): Promise<RetrievalResult[]> {
  const queryVector = embedWithHashing([{ id: "__query__", content: query }]).get("__query__") ?? [];
  return chunks
    .map((chunk) => {
      const section = chunk.metadata.sectionTitle ? ` > ${chunk.metadata.sectionTitle}` : "";
      const embedding = embedWithHashing([{ id: chunk.id, content: chunk.content }]).get(chunk.id) ?? [];
      return {
        chunk: {
          ...chunk,
          embedding,
        },
        score: cosineSimilarity(queryVector, embedding),
        source: `${chunk.metadata.docFileName}${section}`,
      } satisfies RetrievalResult;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function takeTopResults(results: RetrievalResult[], topK: number): RetrievalResult[] {
  return results.slice(0, topK);
}

export function resolveCandidatePoolSize(
  topK: number,
  candidatePoolMultiplier: number = DEFAULT_CANDIDATE_POOL_MULTIPLIER,
  candidatePoolMin: number = DEFAULT_CANDIDATE_POOL_MIN,
): number {
  return Math.max(candidatePoolMin, topK * candidatePoolMultiplier);
}

export function expandQueries(query: string, limit: number = DEFAULT_QUERY_REWRITE_LIMIT): string[] {
  const normalized = query.trim();
  if (!normalized) {
    return [];
  }

  const variants = [
    normalized,
    tokenize(normalized).join(" "),
    normalized.replace(/\s+/g, " "),
    normalized.replace(/[，。、“”"'`]/g, " "),
  ];

  return [...new Set(variants.map((item) => item.trim()).filter(Boolean))].slice(0, limit);
}

function dedupeByChunkId(results: RetrievalResult[]): RetrievalResult[] {
  const deduped = new Map<string, RetrievalResult>();
  for (const item of results) {
    const existing = deduped.get(item.chunk.id);
    if (!existing || item.score > existing.score) {
      deduped.set(item.chunk.id, item);
    }
  }
  return [...deduped.values()].sort((a, b) => b.score - a.score);
}

function mapKeywordRows(
  rows: { id: string; score: number }[],
  chunkMap: Map<string, Awaited<ReturnType<VectorStore["listChunks"]>>[number]>,
): RetrievalResult[] {
  return rows
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
}

export async function retrieve(
  query: string,
  kbId: string,
  apiConfig: ApiConfig,
  options?: RetrieveOptions,
): Promise<RetrievalResult[]> {
  const topK = options?.topK ?? DEFAULT_TOP_K;
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const candidatePoolSize = resolveCandidatePoolSize(
    topK,
    options?.candidatePoolMultiplier,
    options?.candidatePoolMin,
  );
  const expandedQueries = expandQueries(query, options?.queryRewriteLimit);
  if (expandedQueries.length === 0) {
    return [];
  }
  const store = await getStore(kbId);
  const stats = store.getStats();
  if (stats.chunkCount === 0) {
    return [];
  }
  const allChunks = await store.listChunks();
  const storedDimension = hasConsistentEmbeddingDimensions(allChunks);
  const queryEmbedding = await embedChunks([{ id: "__query__", content: query }], apiConfig);
  const queryVector = queryEmbedding.get("__query__") ?? [];
  const useStoredSemantic =
    Boolean(apiConfig.apiKey && apiConfig.baseURL) &&
    storedDimension !== null &&
    queryVector.length === storedDimension;
  const chunkMap = new Map(allChunks.map((chunk) => [chunk.id, chunk]));
  const semanticResults = (
    await Promise.all(
      expandedQueries.map(async (variant) => {
        if (useStoredSemantic) {
          const variantEmbedding = await embedChunks([{ id: "__query__", content: variant }], apiConfig);
          const variantVector = variantEmbedding.get("__query__") ?? [];
          return store.search(variantVector, candidatePoolSize);
        }
        return localSemanticSearch(variant, allChunks, candidatePoolSize);
      }),
    )
  ).flat();
  const keywordRows = expandedQueries.flatMap((variant) =>
    keywordSearch(
      variant,
      allChunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
      candidatePoolSize,
    ),
  );
  const keywordResults = dedupeByChunkId(mapKeywordRows(keywordRows, chunkMap));

  const fused = rrfFuse(dedupeByChunkId(semanticResults), keywordResults)
    .filter((item) => item.score >= minScore)
    .slice(0, candidatePoolSize);

  const reranked = mmrRerank(fused, candidatePoolSize, 0.3);
  const diversified = applySoftDiversification(reranked);
  return takeTopResults(diversified, topK);
}

export function clearStoreCache(kbId?: string): void {
  if (kbId) {
    storeCache.delete(kbId);
  } else {
    storeCache.clear();
  }
}
