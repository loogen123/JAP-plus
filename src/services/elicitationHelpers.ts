export type ClarificationQuestionLike = {
  dimension: string;
  options?: string[];
  questionText?: string;
  questionType: string;
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\r\n\t]+/g, "")
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()【】\[\]{}<>《》\-—_]/g, "");
}

export function buildQuestionSignature(
  question: ClarificationQuestionLike,
): string {
  const optionSig = [...(question.options ?? [])]
    .map((item) => normalizeText(String(item)))
    .sort()
    .join("|");
  return [
    question.dimension,
    question.questionType,
    normalizeText(question.questionText ?? ""),
    optionSig,
  ].join("#");
}

export function dedupeQuestions<T extends ClarificationQuestionLike>(
  questions: T[],
  existingSignatures: Set<string>,
  maxCount: number,
): { questions: T[]; dropped: number } {
  const out: T[] = [];
  let dropped = 0;
  const localSeen = new Set<string>();
  for (const item of questions) {
    const sig = buildQuestionSignature(item);
    const shortSig = `${item.dimension}#${item.questionType}#${normalizeText(item.questionText ?? "")}`;
    if (existingSignatures.has(sig) || existingSignatures.has(shortSig)) {
      dropped++;
      continue;
    }
    if (localSeen.has(sig) || localSeen.has(shortSig)) {
      dropped++;
      continue;
    }
    localSeen.add(sig);
    localSeen.add(shortSig);
    existingSignatures.add(sig);
    existingSignatures.add(shortSig);
    out.push(item);
    if (out.length >= maxCount) {
      break;
    }
  }
  return { questions: out, dropped };
}

export function stringifyAnswer(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(" | ");
  }
  return String(value ?? "");
}

export function normalizePrdDraft(rawDraft: string): string {
  return rawDraft
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
