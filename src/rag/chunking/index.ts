import type { ChunkBlockType, ChunkDraft, ChunkMeta, ChunkOptions } from "../types.js";

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 100;
const DEFAULT_MIN_CHUNK_SIZE = 50;
const CHARS_PER_TOKEN = 2.5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type HeadingState = {
  level: number;
  title: string;
};

type ParsedBlock = {
  content: string;
  blockType: ChunkBlockType;
  sectionTitle?: string;
  path: string[];
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
};

function buildLineOffsets(text: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function lineEndOffset(lines: string[], lineOffsets: number[], lineIndex: number): number {
  const startOffset = lineOffsets[lineIndex] ?? 0;
  const line = lines[lineIndex] ?? "";
  return startOffset + line.length;
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim());
}

function isListLine(line: string): boolean {
  return /^(\s*[-*+]\s+|\s*\d+\.\s+)/.test(line);
}

function isQuoteLine(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && !isFenceLine(trimmed);
}

function isStructuralLine(line: string): boolean {
  return isHeadingLine(line) || isFenceLine(line) || isListLine(line) || isQuoteLine(line) || isTableLine(line);
}

function getHeadingState(line: string): HeadingState | null {
  const match = line.trim().match(/^(#{1,6})\s+(.+)$/);
  if (!match) {
    return null;
  }
  const hashes = match[1];
  const title = match[2];
  if (!hashes || !title) {
    return null;
  }
  return {
    level: hashes.length,
    title: title.trim(),
  };
}

function appendBlock(
  blocks: ParsedBlock[],
  lines: string[],
  lineOffsets: number[],
  startLine: number,
  endLine: number,
  blockType: ChunkBlockType,
  path: string[],
): void {
  const content = lines.slice(startLine, endLine + 1).join("\n").trim();
  if (!content) {
    return;
  }
  const sectionTitle = path[path.length - 1];
  blocks.push({
    content,
    blockType,
    path,
    startLine: startLine + 1,
    endLine: endLine + 1,
    startOffset: lineOffsets[startLine] ?? 0,
    endOffset: lineEndOffset(lines, lineOffsets, endLine),
    ...(sectionTitle ? { sectionTitle } : {}),
  });
}

function parseBlocks(text: string): ParsedBlock[] {
  const lines = text.split("\n");
  const lineOffsets = buildLineOffsets(text);
  const blocks: ParsedBlock[] = [];
  const headingStack: HeadingState[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (isBlankLine(line)) {
      index += 1;
      continue;
    }

    const heading = getHeadingState(line);
    if (heading) {
      headingStack.splice(heading.level - 1);
      headingStack[heading.level - 1] = heading;
      index += 1;
      continue;
    }

    const path = headingStack.map((item) => item.title);

    if (isFenceLine(line)) {
      const fence = line.trim().slice(0, 3);
      const startLine = index;
      index += 1;
      while (index < lines.length && !lines[index]?.trim().startsWith(fence)) {
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      appendBlock(blocks, lines, lineOffsets, startLine, Math.max(startLine, index - 1), "code", [...path]);
      continue;
    }

    if (isListLine(line)) {
      const startLine = index;
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (isBlankLine(current) || isHeadingLine(current) || isFenceLine(current)) {
          break;
        }
        if (!isListLine(current) && !/^\s+/.test(current)) {
          break;
        }
        index += 1;
      }
      appendBlock(blocks, lines, lineOffsets, startLine, index - 1, "list", [...path]);
      continue;
    }

    if (isQuoteLine(line)) {
      const startLine = index;
      index += 1;
      while (index < lines.length && isQuoteLine(lines[index] ?? "")) {
        index += 1;
      }
      appendBlock(blocks, lines, lineOffsets, startLine, index - 1, "quote", [...path]);
      continue;
    }

    if (isTableLine(line)) {
      const startLine = index;
      index += 1;
      while (index < lines.length && isTableLine(lines[index] ?? "")) {
        index += 1;
      }
      appendBlock(blocks, lines, lineOffsets, startLine, index - 1, "table", [...path]);
      continue;
    }

    const startLine = index;
    index += 1;
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (isBlankLine(current) || isStructuralLine(current)) {
        break;
      }
      index += 1;
    }
    appendBlock(blocks, lines, lineOffsets, startLine, index - 1, "paragraph", [...path]);
  }

  return blocks;
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

function canMergeBlocks(previous: ParsedBlock, current: ParsedBlock): boolean {
  if (previous.blockType !== current.blockType || previous.blockType === "code") {
    return false;
  }
  return previous.path.join("\u0000") === current.path.join("\u0000");
}

function mergeBlocks(previous: ParsedBlock, current: ParsedBlock): ParsedBlock {
  return {
    ...previous,
    content: `${previous.content}\n\n${current.content}`,
    endLine: current.endLine,
    endOffset: current.endOffset,
  };
}

function mergeSmallBlocks(blocks: ParsedBlock[], minChunkSize: number): ParsedBlock[] {
  const merged: ParsedBlock[] = [];
  const queue = [...blocks];
  let index = 0;

  while (index < queue.length) {
    const current = queue[index];
    if (!current) {
      index += 1;
      continue;
    }

    if (estimateTokens(current.content) >= minChunkSize) {
      merged.push(current);
      index += 1;
      continue;
    }

    const previous = merged[merged.length - 1];
    if (previous && canMergeBlocks(previous, current)) {
      merged[merged.length - 1] = mergeBlocks(previous, current);
      index += 1;
      continue;
    }

    const next = queue[index + 1];
    if (next && canMergeBlocks(current, next)) {
      queue[index + 1] = mergeBlocks(current, next);
      index += 1;
      continue;
    }

    merged.push(current);
    index += 1;
  }

  return merged;
}

function splitOversizeBlocks(blocks: ParsedBlock[], chunkSize: number, chunkOverlap: number): ParsedBlock[] {
  return blocks.flatMap((block) => {
    if (!["paragraph", "code"].includes(block.blockType) || estimateTokens(block.content) <= chunkSize) {
      return [block];
    }

    const parts = splitByFixedSize(block.content, chunkSize, chunkOverlap);
    let cursor = 0;
    return parts.map((part) => {
      const startOffset = block.startOffset + cursor;
      cursor += part.length;
      return {
        ...block,
        content: part,
        startOffset,
        endOffset: startOffset + part.length,
      };
    });
  });
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
  const parsed = parseBlocks(normalized);
  const merged = mergeSmallBlocks(parsed, minChunkSize);
  const finalBlocks = splitOversizeBlocks(merged, chunkSize, chunkOverlap);

  return finalBlocks.map((block, chunkIndex) => {
    const metadata: ChunkMeta = {
      docFileName,
      chunkIndex,
      lineRange: [block.startLine, block.endLine],
      tokenCount: estimateTokens(block.content),
      ...(block.sectionTitle ? { sectionTitle: block.sectionTitle } : {}),
      ...(block.blockType ? { blockType: block.blockType } : {}),
      ...(block.path.length > 0 ? { path: block.path } : {}),
      ...(block.startOffset !== undefined ? { startOffset: block.startOffset } : {}),
      ...(block.endOffset !== undefined ? { endOffset: block.endOffset } : {}),
    };
    return { content: block.content, metadata };
  });
}
