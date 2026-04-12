type MessageWithContent = {
  content: unknown;
};

type SafeParseResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
    };

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          (item as { type?: string }).type === "text" &&
          "text" in item
        ) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function parseJsonFromMessageContent(content: unknown): unknown | null {
  const rawText = extractTextFromMessageContent(content);
  const rawJson = extractJsonObject(rawText);
  if (!rawJson) {
    return null;
  }
  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

export async function invokeStructuredWithJsonFallback<T>(params: {
  invokeStructured: () => Promise<T>;
  invokeFallback: () => Promise<MessageWithContent>;
  safeParse: (value: unknown) => SafeParseResult<T>;
}): Promise<{ result: T; usedFallback: boolean }> {
  try {
    const result = await params.invokeStructured();
    return { result, usedFallback: false };
  } catch (structuredError) {
    const fallbackMessage = await params.invokeFallback();
    const parsedJson = parseJsonFromMessageContent(fallbackMessage.content);
    if (!parsedJson) {
      throw structuredError;
    }

    const parsed = params.safeParse(parsedJson);
    if (!parsed.success) {
      throw structuredError;
    }

    return {
      result: parsed.data,
      usedFallback: true,
    };
  }
}
