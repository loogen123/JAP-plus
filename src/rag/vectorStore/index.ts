import fs from "node:fs/promises";
import path from "node:path";
import type { Chunk, ChunksIndexEntry, RetrievalResult } from "../types.js";
import { cosineSimilarity } from "../embedding/index.js";

type HnswInstance = {
  initIndex(maxElements: number, M?: number, efConstruction?: number, randomSeed?: number): void;
  addPoint(point: number[], idx: number): void;
  searchKnn(query: number[], k: number): { distances: number[]; neighbors: number[] };
  writeIndex(filePath: string): void;
  setEf(ef: number): void;
};

type HnswModule = {
  HierarchicalNSW: new (space: string, dim: number) => HnswInstance;
};

const HNSW_PATH_FILE = "vectors.hnsw";
const CHUNK_INDEX_FILE = "chunks-index.json";
const EMBEDDINGS_FILE = "embeddings.json";

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function loadHnswModule(): Promise<HnswModule | null> {
  try {
    return (await import("hnswlib-node")) as unknown as HnswModule;
  } catch {
    return null;
  }
}

export interface VectorStore {
  addVectors(chunks: Chunk[]): Promise<void>;
  search(queryVector: number[], topK: number): Promise<RetrievalResult[]>;
  deleteByDocId(docId: string): Promise<void>;
  deleteAll(): Promise<void>;
  getStats(): { chunkCount: number; dimension: number };
  listChunks(): Promise<Chunk[]>;
}

export async function createVectorStore(kbPath: string): Promise<VectorStore> {
  await ensureDir(kbPath);
  const hnswPath = path.join(kbPath, HNSW_PATH_FILE);
  const chunksPath = path.join(kbPath, CHUNK_INDEX_FILE);
  const embeddingsPath = path.join(kbPath, EMBEDDINGS_FILE);

  const chunksIndex = await readJsonFile<ChunksIndexEntry[]>(chunksPath, []);
  const embeddings = await readJsonFile<Record<string, number[]>>(embeddingsPath, {});

  let hnswModule: HnswModule | null = null;
  let hnswIndex: HnswInstance | null = null;
  let hnswDim = 0;

  function inferDimension(): number {
    for (const vector of Object.values(embeddings)) {
      if (vector.length > 0) {
        return vector.length;
      }
    }
    return 1536;
  }

  async function rebuildHnsw(): Promise<void> {
    if (!hnswModule) {
      hnswModule = await loadHnswModule();
    }
    if (!hnswModule) {
      hnswIndex = null;
      return;
    }
    hnswDim = inferDimension();
    hnswIndex = new hnswModule.HierarchicalNSW("cosine", hnswDim);
    const validRows = chunksIndex
      .map((chunk, index) => ({ chunk, index, embedding: embeddings[chunk.id] }))
      .filter((row) => Array.isArray(row.embedding) && row.embedding.length > 0);
    hnswIndex.initIndex(Math.max(1000, validRows.length + 50), 16, 200, 42);
    hnswIndex.setEf(100);
    for (const row of validRows) {
      const vector = row.embedding;
      if (!vector) {
        continue;
      }
      hnswIndex.addPoint(vector, row.index);
    }
    hnswIndex.writeIndex(hnswPath);
  }

  async function persist(): Promise<void> {
    await writeJsonFile(chunksPath, chunksIndex);
    await writeJsonFile(embeddingsPath, embeddings);
    if (hnswIndex) {
      hnswIndex.writeIndex(hnswPath);
    }
  }

  await rebuildHnsw();

  function toSource(entry: ChunksIndexEntry): string {
    const section = entry.metadata.sectionTitle ? ` > ${entry.metadata.sectionTitle}` : "";
    return `${entry.metadata.docFileName}${section}`;
  }

  return {
    async addVectors(chunks: Chunk[]): Promise<void> {
      if (chunks.length === 0) {
        return;
      }
      for (const chunk of chunks) {
        chunksIndex.push({
          id: chunk.id,
          docId: chunk.docId,
          kbId: chunk.kbId,
          content: chunk.content,
          metadata: chunk.metadata,
        });
        embeddings[chunk.id] = chunk.embedding;
      }
      await rebuildHnsw();
      await persist();
    },
    async search(queryVector: number[], topK: number): Promise<RetrievalResult[]> {
      if (topK <= 0 || chunksIndex.length === 0) {
        return [];
      }
      if (hnswIndex && queryVector.length === hnswDim) {
        const res = hnswIndex.searchKnn(queryVector, Math.min(topK, chunksIndex.length));
        return res.neighbors
          .map((neighbor, idx) => {
            const entry = chunksIndex[neighbor];
            if (!entry) {
              return null;
            }
            return {
              chunk: {
                ...entry,
                embedding: embeddings[entry.id] ?? [],
              } as Chunk,
              score: 1 - (res.distances[idx] ?? 1),
              source: toSource(entry),
              kbId: entry.kbId,
              kbName: "",
            } satisfies RetrievalResult;
          })
          .filter((item): item is RetrievalResult => item !== null);
      }
      const scored = chunksIndex
        .map((entry) => {
          const vector = embeddings[entry.id] ?? [];
          return {
            chunk: {
              ...entry,
              embedding: vector,
            } as Chunk,
            score: cosineSimilarity(queryVector, vector),
            source: toSource(entry),
            kbId: entry.kbId,
            kbName: "",
          } satisfies RetrievalResult;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return scored;
    },
    async deleteByDocId(docId: string): Promise<void> {
      for (let i = chunksIndex.length - 1; i >= 0; i -= 1) {
        const entry = chunksIndex[i];
        if (entry?.docId === docId) {
          const chunkId = entry.id;
          delete embeddings[chunkId];
          chunksIndex.splice(i, 1);
        }
      }
      await rebuildHnsw();
      await persist();
    },
    async deleteAll(): Promise<void> {
      chunksIndex.length = 0;
      for (const key of Object.keys(embeddings)) {
        delete embeddings[key];
      }
      await rebuildHnsw();
      await persist();
    },
    getStats() {
      return { chunkCount: chunksIndex.length, dimension: inferDimension() };
    },
    async listChunks(): Promise<Chunk[]> {
      return chunksIndex.map((entry) => ({
        ...entry,
        embedding: embeddings[entry.id] ?? [],
      }));
    },
  };
}
