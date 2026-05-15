import { tokenize } from "../embedding/index.js";

const K1 = 1.5;
const B = 0.75;

function termFreqMap(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

function computeIdfMap(chunks: { content: string }[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const terms = new Set(tokenize(chunk.content));
    for (const term of terms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const totalDocs = Math.max(chunks.length, 1);
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + (totalDocs - count + 0.5) / (count + 0.5)));
  }
  return idf;
}

export function bm25Score(query: string, docText: string, avgDocLen?: number, docLen?: number): number {
  const queryTerms = tokenize(query);
  const docTerms = tokenize(docText);
  if (queryTerms.length === 0 || docTerms.length === 0) {
    return 0;
  }
  const tf = termFreqMap(docTerms);
  const dl = docLen ?? docTerms.length;
  const avgdl = avgDocLen && avgDocLen > 0 ? avgDocLen : dl || 1;
  const fallbackIdf = new Map<string, number>();
  for (const term of new Set(queryTerms)) {
    fallbackIdf.set(term, 1);
  }
  const idfMap = fallbackIdf;
  let score = 0;
  for (const term of queryTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) {
      continue;
    }
    const idf = idfMap.get(term) ?? 1;
    score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (dl / avgdl))));
  }
  return score;
}

export function keywordSearch(
  query: string,
  chunks: { id: string; content: string }[],
  topK: number = 10,
): { id: string; score: number }[] {
  if (chunks.length === 0) {
    return [];
  }
  const avgLen = chunks.reduce((sum, chunk) => sum + tokenize(chunk.content).length, 0) / chunks.length;
  const idfMap = computeIdfMap(chunks);
  return chunks
    .map((chunk) => ({
      id: chunk.id,
      score: (() => {
        const queryTerms = tokenize(query);
        const docTerms = tokenize(chunk.content);
        if (queryTerms.length === 0 || docTerms.length === 0) {
          return 0;
        }
        const tf = termFreqMap(docTerms);
        let total = 0;
        for (const term of queryTerms) {
          const f = tf.get(term) ?? 0;
          if (f === 0) {
            continue;
          }
          const idf = idfMap.get(term) ?? 0;
          total += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (docTerms.length / avgLen))));
        }
        return total;
      })(),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
