import { randomUUID } from "node:crypto";
import type { RAGDocument } from "../types.js";
import { parseDocument } from "./parsers.js";

export type IngestResult = {
  document: RAGDocument;
  text: string;
  error?: string;
};

export async function ingestDocument(
  kbId: string,
  filePath: string,
  fileName: string,
): Promise<IngestResult> {
  const { text, fileType, error } = await parseDocument(filePath, fileName);
  const document: RAGDocument = {
    id: randomUUID(),
    kbId,
    fileName,
    fileType,
    filePath,
    extractedAt: new Date().toISOString(),
    chunkIds: [],
  };
  if (error) {
    return { document, text, error };
  }
  return { document, text };
}

export async function ingestDocuments(
  kbId: string,
  files: { filePath: string; fileName: string }[],
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const file of files) {
    try {
      const result = await ingestDocument(kbId, file.filePath, file.fileName);
      results.push(result);
    } catch (error) {
      results.push({
        document: {
          id: randomUUID(),
          kbId,
          fileName: file.fileName,
          fileType: "txt",
          filePath: file.filePath,
          extractedAt: new Date().toISOString(),
          chunkIds: [],
        },
        text: "",
        error: `ingestion failed: ${String(error)}`,
      });
    }
  }
  return results;
}
