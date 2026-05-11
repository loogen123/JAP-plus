import type { ApiConfig } from "../types.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

type EmbedChunk = { id: string; content: string };
type EmbedResult = Map<string, number[]>;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const segments = text.split(/\s+/g).filter(Boolean);
  for (const segment of segments) {
    if (/[一-龥]/.test(segment)) {
      for (const char of segment) {
        if (/[一-龥]/.test(char)) {
          tokens.push(char);
        }
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

export function embedWithTfIdf(chunks: EmbedChunk[]): EmbedResult {
  const result: EmbedResult = new Map();
  if (chunks.length === 0) {
    return result;
  }
  const df = new Map<string, number>();
  const docsTf: Map<string, number>[] = [];
  for (const chunk of chunks) {
    const tokens = tokenize(chunk.content);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    docsTf.push(tf);
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const terms = [...df.keys()];
  const docCount = chunks.length;
  const idf = new Map<string, number>();
  for (const term of terms) {
    idf.set(term, Math.log((docCount + 1) / ((df.get(term) ?? 0) + 1)) + 1);
  }
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const tf = docsTf[i];
    if (!chunk || !tf) {
      continue;
    }
    result.set(chunk.id, computeTfIdfVector(tf, idf, terms));
  }
  return result;
}

export async function embedChunks(chunks: EmbedChunk[], apiConfig: ApiConfig): Promise<EmbedResult> {
  const result: EmbedResult = new Map();
  if (chunks.length === 0) {
    return result;
  }
  if (!apiConfig.apiKey || !apiConfig.baseURL) {
    return embedWithTfIdf(chunks);
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
    return embedWithTfIdf(chunks);
  } catch {
    return embedWithTfIdf(chunks);
  }
}
