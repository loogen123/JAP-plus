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

export function bm25Score(query: string, docText: string, avgDocLen?: number, docLen?: number): number {
  const queryTerms = tokenize(query);
  const docTerms = tokenize(docText);
  if (queryTerms.length === 0 || docTerms.length === 0) {
    return 0;
  }
  const tf = termFreqMap(docTerms);
  const dl = docLen ?? docTerms.length;
  const avgdl = avgDocLen && avgDocLen > 0 ? avgDocLen : dl || 1;
  let score = 0;
  for (const term of queryTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) {
      continue;
    }
    const idf = 1;
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
  return chunks
    .map((chunk) => ({
      id: chunk.id,
      score: bm25Score(query, chunk.content, avgLen, tokenize(chunk.content).length),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
