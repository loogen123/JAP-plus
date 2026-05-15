import type { ApiConfig } from "../types.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;
const HASH_EMBEDDING_DIM = 256;

type EmbedChunk = { id: string; content: string };
type EmbedResult = Map<string, number[]>;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const segments = text.match(/[\u4e00-\u9fff]+|[a-zA-Z0-9_]+/g) ?? [];
  for (const segment of segments) {
    if (/^[\u4e00-\u9fff]+$/.test(segment)) {
      tokens.push(segment);
      for (const char of segment) {
        tokens.push(char);
      }
      for (let i = 0; i < segment.length - 1; i += 1) {
        tokens.push(segment.slice(i, i + 2));
      }
    } else {
      tokens.push(segment.toLowerCase());
    }
  }
  return tokens;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const size = Math.min(a.length, b.length);
  if (size === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < size; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function computeTfIdfVector(tf: Map<string, number>, idf: Map<string, number>, terms: string[]): number[] {
  return terms.map((term) => (tf.get(term) ?? 0) * (idf.get(term) ?? 0));
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

export function embedWithHashing(chunks: EmbedChunk[], dimension: number = HASH_EMBEDDING_DIM): EmbedResult {
  const result: EmbedResult = new Map();
  if (chunks.length === 0) {
    return result;
  }
  for (const chunk of chunks) {
    const tokens = tokenize(chunk.content);
    const vector = new Array(dimension).fill(0);
    for (const token of tokens) {
      const hash = hashToken(token);
      const index = hash % dimension;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[index] += sign;
    }
    result.set(chunk.id, normalizeVector(vector));
  }
  return result;
}

export async function embedChunks(chunks: EmbedChunk[], apiConfig: ApiConfig): Promise<EmbedResult> {
  const result: EmbedResult = new Map();
  if (chunks.length === 0) {
    return result;
  }
  if (!apiConfig.apiKey || !apiConfig.baseURL) {
    return embedWithHashing(chunks);
  }
  try {
    const model = apiConfig.model ?? EMBEDDING_MODEL;
    const url = `${apiConfig.baseURL.replace(/\/+$/, "")}/embeddings`;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiConfig.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: batch.map((chunk) => chunk.content),
        }),
      });
      if (!resp.ok) {
        throw new Error(`embedding api error: ${resp.status}`);
      }
      const json = (await resp.json()) as { data?: Array<{ index: number; embedding: number[] }> };
      for (const item of json.data ?? []) {
        const row = batch[item.index];
        if (row?.id && Array.isArray(item.embedding)) {
          result.set(row.id, item.embedding);
        }
      }
    }
    if (result.size === chunks.length) {
      return result;
    }
    return embedWithHashing(chunks);
  } catch {
    return embedWithHashing(chunks);
  }
}
