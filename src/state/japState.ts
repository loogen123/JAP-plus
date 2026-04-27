import { z } from "zod";

export const QuestionDimensionSchema = z.enum([
  "\u6838\u5fc3\u5b9e\u4f53",
  "\u72b6\u6001\u8fb9\u754c",
  "\u5b89\u5168\u6743\u9650",
  "\u5916\u90e8\u4f9d\u8d56",
]);

export const QuestionSchema = z.object({
  id: z.string(),
  dimension: QuestionDimensionSchema,
  questionType: z.enum(["single", "multiple"]),
  questionText: z.string(),
  options: z.array(z.string()).min(2).max(8),
});

export const QuestionnaireSchema = z.object({
  questions: z.array(QuestionSchema).min(0).max(100),
});

export const ModelingOutputSchema = z.object({
  "01_\u9700\u6c42\u7b80\u62a5.md": z.string(),
  "02_\u9886\u57df\u8bcd\u5178.md": z.string(),
  "03_\u884c\u4e3a\u89c4\u5219.md": z.string(),
  "04_\u80fd\u529b\u610f\u56fe.md": z.string(),
});

export const DetailingOutputSchema = z.object({
  "05_Agent\u6267\u884c\u6307\u5357.md": z.string(),
  "06_\u9a8c\u6536\u6e05\u5355.md": z.string(),
  "07_SDD\u7ea6\u675f\u603b\u89c8.md": z.string(),
});

export interface JapState {
  originalRequirement: string;
  questionnaire: z.infer<typeof QuestionnaireSchema> | null;
  userAnswers: Record<string, string | string[]>;
  artifacts: Record<string, string>;
  errors: string[];
  llmConfig:
    | {
        baseUrl: string;
        apiKey: string;
        modelName: string;
      }
    | null;
  workspaceConfig?:
    | {
        path: string;
      }
    | null;
}
