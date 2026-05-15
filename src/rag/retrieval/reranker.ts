import type { RetrievalResult } from "../types.js";
import { cosineSimilarity } from "../embedding/index.js";

const RRF_K = 60;

export function rrfFuse(semantic: RetrievalResult[], keyword: RetrievalResult[]): RetrievalResult[] {
  const scoreMap = new Map<string, { result: RetrievalResult; score: number }>();
  for (let i = 0; i < semantic.length; i += 1) {
    const row = semantic[i];
    if (!row) {
      continue;
    }
    scoreMap.set(row.chunk.id, {
      result: row,
      score: 1 / (RRF_K + i + 1),
    });
  }
  for (let i = 0; i < keyword.length; i += 1) {
    const row = keyword[i];
    if (!row) {
      continue;
    }
    const existing = scoreMap.get(row.chunk.id);
    if (existing) {
      existing.score += 1 / (RRF_K + i + 1);
      if (row.score > existing.result.score) {
        existing.result.score = row.score;
      }
    } else {
      scoreMap.set(row.chunk.id, {
        result: row,
        score: 1 / (RRF_K + i + 1),
      });
    }
  }
  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.result, score: entry.score }));
}

export function mmrRerank(
  results: RetrievalResult[],
  topK: number = 5,
  diversityWeight: number = 0.3,
): RetrievalResult[] {
  if (results.length <= topK) {
    return results;
  }
  const selected: RetrievalResult[] = [];
  const remaining = [...results];
  selected.push(remaining.shift() as RetrievalResult);
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (!candidate) {
        continue;
      }
      const relevance = candidate.score;
      let maxSimilarity = 0;
      for (const chosen of selected) {
        maxSimilarity = Math.max(
          maxSimilarity,
          cosineSimilarity(candidate.chunk.embedding, chosen.chunk.embedding),
        );
      }
      const mmr = diversityWeight * relevance - (1 - diversityWeight) * maxSimilarity;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    if (!next) {
      break;
    }
    selected.push(next);
  }
  return selected;
}

export function applySoftDiversification(
  results: RetrievalResult[],
  decay: number = 0.92,
): RetrievalResult[] {
  const counts = new Map<string, number>();
  return [...results]
    .map((item) => {
      const seen = counts.get(item.chunk.docId) ?? 0;
      counts.set(item.chunk.docId, seen + 1);
      return {
        ...item,
        score: item.score * Math.pow(decay, seen),
      };
    })
    .sort((a, b) => b.score - a.score);
}
