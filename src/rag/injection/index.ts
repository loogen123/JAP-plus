import type { RetrievalResult } from "../types.js";

const DEFAULT_MAX_TOKENS = 3000;
const CHARS_PER_TOKEN = 2.5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function buildRAGPrompt(
  results: RetrievalResult[],
  maxTokens?: number,
): string {
  if (results.length === 0) {
    return "";
  }
  const tokenLimit = maxTokens ?? DEFAULT_MAX_TOKENS;
  const kbNames = [...new Set(results.map((item) => item.kbName.trim()).filter(Boolean))];
  const kbLabel = kbNames.length > 0 ? kbNames.map((item) => `"${item}"`).join("、") : "已绑定知识库";
  const header = `\n\n## 参考知识\n\n以下是从知识库${kbLabel}中检索到的相关内容，请在生成设计文档时参考：\n\n`;
  let body = "";
  let usedTokens = estimateTokens(header);
  const sorted = [...results].sort((a, b) => b.score - a.score);
  for (let i = 0; i < sorted.length; i += 1) {
    const result = sorted[i];
    if (!result) {
      continue;
    }
    const quote = result.chunk.content
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const parentPath = result.chunk.metadata.parentPath?.join(" > ");
    const parentContext = result.chunk.metadata.parentContext?.trim();
    const prefix = parentPath ? `章节：${parentPath}\n` : "";
    const context = parentContext ? `父级上下文：${parentContext}\n\n` : "";
    const kbLine = result.kbName ? `知识库：${result.kbName}\n` : "";
    const citation = `### 引用 ${i + 1}（知识库：${result.kbName || "未知"}，来源：${result.source}，相关度：${result.score.toFixed(2)}）\n${kbLine}${prefix}${context}${quote}\n\n`;
    const citationTokens = estimateTokens(citation);
    if (usedTokens + citationTokens > tokenLimit) {
      break;
    }
    usedTokens += citationTokens;
    body += citation;
  }
  return body ? `${header}${body}---\n` : "";
}
