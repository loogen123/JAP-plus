import { z } from "zod";

export const SddApiConstraintSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).or(z.string().min(1)),
  path: z.string().min(1),
  auth: z.enum(["none", "bearer", "cookie", "apikey", "unknown"]).default("unknown"),
  requiredRequestFields: z.array(z.string()).default([]),
  requiredResponseFields: z.array(z.string()).default([]),
  errorCodes: z.array(z.string()).default([]),
});

export const SddTableConstraintSchema = z.object({
  name: z.string().min(1),
  primaryKey: z.string().min(1).optional().default("id"),
  requiredColumns: z.array(z.string()).default([]),
  indexes: z.array(z.string()).default([]),
});

export const SddStateTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  trigger: z.string().optional().default(""),
  notes: z.string().optional().default(""),
});

export const SddStateMachineConstraintSchema = z.object({
  name: z.string().min(1),
  states: z.array(z.string()).default([]),
  transitions: z.array(SddStateTransitionSchema).default([]),
});

export const SddConstraintsSchema = z.object({
  version: z.string().default("1"),
  generatedAt: z.string().optional(),
  apis: z.array(SddApiConstraintSchema).default([]),
  tables: z.array(SddTableConstraintSchema).default([]),
  stateMachines: z.array(SddStateMachineConstraintSchema).default([]),
  notes: z.string().optional(),
});

export type SddConstraints = z.infer<typeof SddConstraintsSchema>;

