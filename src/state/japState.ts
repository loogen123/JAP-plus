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
  "01_\u4ea7\u54c1\u529f\u80fd\u8111\u56fe\u4e0e\u7528\u4f8b.md": z.string(),
  "02_\u9886\u57df\u6a21\u578b\u4e0e\u7269\u7406\u8868\u7ed3\u6784.md": z.string(),
  "03_\u6838\u5fc3\u4e1a\u52a1\u72b6\u6001\u673a.md": z.string(),
  "04_RESTful_API\u5951\u7ea6.yaml": z.string(),
});

export const DetailingOutputSchema = z.object({
  "05_\u884c\u4e3a\u9a71\u52a8\u9a8c\u6536\u6d4b\u8bd5.md": z.string(),
  "06_UI\u539f\u578b\u4e0e\u4ea4\u4e92\u8349\u56fe.html": z.string(),
  "07_API\u8c03\u8bd5\u96c6\u5408.json": z.string(),
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
