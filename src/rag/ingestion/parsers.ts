import fs from "node:fs/promises";
import path from "node:path";
import type { DocFileType } from "../types.js";

type ParseResult = {
  text: string;
  error?: string;
};

const FILE_TYPE_MAP: Record<string, DocFileType> = {
  pdf: "pdf",
  docx: "docx",
  md: "md",
  txt: "txt",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  json: "code",
  yaml: "code",
  yml: "code",
  py: "code",
  java: "code",
  go: "code",
  rs: "code",
  sh: "code",
  sql: "code",
};

export function detectFileType(fileName: string): DocFileType {
  const ext = path.extname(fileName).replace(".", "").toLowerCase();
  return FILE_TYPE_MAP[ext] ?? "txt";
}

async function parsePlainText(filePath: string): Promise<ParseResult> {
  const text = await fs.readFile(filePath, "utf-8");
  if (!text.trim()) {
    return { text: "", error: "empty file" };
  }
  return { text };
}

async function parsePdf(filePath: string): Promise<ParseResult> {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const buf = await fs.readFile(filePath);
    const parsed = await pdfParse(buf);
    const text = (parsed.text ?? "").trim();
    if (!text) {
      return { text: "", error: "empty file" };
    }
    return { text };
  } catch (error) {
    return { text: "", error: `pdf parse failed: ${String(error)}` };
  }
}

async function parseDocx(filePath: string): Promise<ParseResult> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    const text = (result.value ?? "").trim();
    if (!text) {
      return { text: "", error: "empty file" };
    }
    return { text };
  } catch (error) {
    return { text: "", error: `docx parse failed: ${String(error)}` };
  }
}

export async function parseDocument(
  filePath: string,
  fileName: string,
): Promise<{ text: string; fileType: DocFileType; error?: string }> {
  const fileType = detectFileType(fileName);
  let parsed: ParseResult;
  switch (fileType) {
    case "pdf":
      parsed = await parsePdf(filePath);
      break;
    case "docx":
      parsed = await parseDocx(filePath);
      break;
    default:
      parsed = await parsePlainText(filePath);
      break;
  }
  if (parsed.error) {
    return { text: parsed.text, fileType, error: parsed.error };
  }
  return { text: parsed.text, fileType };
}
