declare module "pdf-parse" {
  const pdfParse: (dataBuffer: Buffer) => Promise<{ text?: string }>;
  export default pdfParse;
}

declare module "mammoth" {
  export function extractRawText(input: { path: string }): Promise<{ value?: string }>;
}

declare module "hnswlib-node" {
  export class HierarchicalNSW {
    constructor(space: string, dim: number);
    initIndex(maxElements: number, M?: number, efConstruction?: number, randomSeed?: number): void;
    addPoint(point: number[], idx: number): void;
    searchKnn(query: number[], k: number): { distances: number[]; neighbors: number[] };
    writeIndex(path: string): void;
    setEf(ef: number): void;
  }
}
