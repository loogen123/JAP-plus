import { z } from "zod";

export const SddGateConflictSchema = z.object({
  category: z.enum(["api", "data", "state", "nonfunctional", "other"]).optional(),
  severity: z.enum(["error", "warning"]).optional(),
  message: z.string(),
  evidence: z.string().optional(),
  suggestion: z.string().optional(),
});

export const SddGateValidationSchema = z.object({
  passed: z.boolean(),
  conflicts: z.array(SddGateConflictSchema).optional(),
  meta: z
    .object({
      usedFallback: z.boolean().optional(),
    })
    .optional(),
});

export type SddGateValidation = z.infer<typeof SddGateValidationSchema>;
