import type { ChunkDraft, ChunkMeta, ChunkOptions } from "../types.js";

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 100;
const DEFAULT_MIN_CHUNK_SIZE = 50;
const CHARS_PER_TOKEN = 2.5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitByMarkdownHeadings(text: string): string[] {
  return text.split(/\n(?=#{1,3}\s)/g).map((s) => s.trim()).filter(Boolean);
}

function splitByParagraphs(text: string): string[] {
  return text.split(/\n{2,}/g).map((s) => s.trim()).filter(Boolean);
}

function splitByFixedSize(text: string, maxTokens: number, overlapTokens: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxTokens * CHARS_PER_TOKEN));
  const overlapChars = Math.max(0, Math.floor(overlapTokens * CHARS_PER_TOKEN));
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) {
      break;
    }
    start = Math.max(0, end - overlapChars);
  }
  return chunks;
}

export function chunkText(
  text: string,
  docFileName: string,
  options?: ChunkOptions,
): ChunkDraft[] {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = options?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const minChunkSize = options?.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const sections = splitByMarkdownHeadings(normalized);
  const segments = sections.flatMap((section) => splitByParagraphs(section));
  const rawChunks: string[] = [];
  for (const segment of segments) {
    if (estimateTokens(segment) > chunkSize) {
      rawChunks.push(...splitByFixedSize(segment, chunkSize, chunkOverlap));
    } else {
      rawChunks.push(segment);
    }
  }
  const merged: string[] = [];
  for (const chunk of rawChunks) {
    if (merged.length > 0 && estimateTokens(chunk) < minChunkSize) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged.map((content, chunkIndex) => {
    const metadata: ChunkMeta = {
      docFileName,
      chunkIndex,
      tokenCount: estimateTokens(content),
    };
    return { content, metadata };
  });
}
