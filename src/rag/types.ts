export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  documentCount: number;
  chunkCount: number;
};

export type DocFileType = "pdf" | "docx" | "md" | "txt" | "code";

export type RAGDocument = {
  id: string;
  kbId: string;
  fileName: string;
  fileType: DocFileType;
  filePath: string;
  extractedAt: string;
  chunkIds: string[];
};

export type ChunkMeta = {
  docFileName: string;
  sectionTitle?: string;
  chunkIndex: number;
  lineRange?: [number, number];
  tokenCount: number;
  blockType?: ChunkBlockType;
  path?: string[];
  startOffset?: number;
  endOffset?: number;
  parentPath?: string[];
  parentContext?: string;
  childIndexInParent?: number;
};

export type ChunkBlockType = "paragraph" | "list" | "table" | "code" | "quote";

export type Chunk = {
  id: string;
  docId: string;
  kbId: string;
  content: string;
  embedding: number[];
  metadata: ChunkMeta;
};

export type ChunkDraft = Omit<Chunk, "id" | "docId" | "kbId" | "embedding">;

export type RetrievalResult = {
  chunk: Chunk;
  score: number;
  source: string;
};

export type RAGContext = {
  query: string;
  results: RetrievalResult[];
  injectedPrompt: string;
};

export type ApiConfig = {
  baseURL: string;
  apiKey: string;
  model?: string;
};

export type ChunkOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
  parentContextChars?: number;
};

export type RetrieveOptions = {
  topK?: number;
  minScore?: number;
  candidatePoolMultiplier?: number;
  candidatePoolMin?: number;
  queryRewriteLimit?: number;
};

export type KBIndex = {
  version: 1;
  entries: KnowledgeBase[];
};

export type DocsIndex = RAGDocument[];

export type ChunksIndexEntry = Omit<Chunk, "embedding">;
export type ChunksIndex = ChunksIndexEntry[];
