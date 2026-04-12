import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { ARTIFACT_FILES, MODELING_ARTIFACT_KEYS } from "../constants/domainConstants.js";
import { REVIEW_NODE_LOG_TEXT } from "../constants/logTexts.js";
import { REVIEW_NODE_SYSTEM_PROMPT } from "../constants/promptTexts.js";
import { loadSkillContext } from "../runtime/skillContext.js";
import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import type { JapState } from "../state/japState.js";

export const ReviewOutputSchema = z.object({
  passed: z.boolean().describe("Whether all strict cross-validation checks passed."),
  validationErrors: z
    .array(z.string())
    .describe("If failed, list concrete conflicts or errors; empty array when passed."),
});

const REQUIRED_ARTIFACT_KEYS = MODELING_ARTIFACT_KEYS;

function runMockReview(state: JapState): z.infer<typeof ReviewOutputSchema> {
  const errors: string[] = [];

  const useCases = state.artifacts[ARTIFACT_FILES.modeling01] ?? "";
  const domainModel = state.artifacts[ARTIFACT_FILES.modeling02] ?? "";
  const stateMachine = state.artifacts[ARTIFACT_FILES.modeling03] ?? "";
  const openapi = state.artifacts[ARTIFACT_FILES.modeling04] ?? "";

  if (!openapi.includes("openapi: 3.0")) {
    errors.push("Artifact 04 must declare openapi: 3.0.x.");
  }
  if (!openapi.includes("/api/v1/orders")) {
    errors.push("Artifact 04 is missing /api/v1/orders endpoint.");
  }
  if (openapi.includes("tenantId") && !domainModel.includes("tenant_id")) {
    errors.push("Field mapping mismatch: tenantId not mapped to tenant_id in artifact 02.");
  }
  if (!stateMachine.includes("stateDiagram-v2")) {
    errors.push("Artifact 03 must include a stateDiagram-v2 definition.");
  }
  if (useCases.includes("UC01") && !stateMachine.includes("PENDING_PAYMENT")) {
    errors.push("Use case UC01 is not covered by state PENDING_PAYMENT.");
  }

  return {
    passed: errors.length === 0,
    validationErrors: errors,
  };
}

export async function reviewNode(state: JapState): Promise<Partial<JapState>> {
  emitStageChanged("QUALITY_REVIEW");
  emitLogAdded("INFO", REVIEW_NODE_LOG_TEXT.startTitle, REVIEW_NODE_LOG_TEXT.startSummary);

  try {
    const missingKeys = REQUIRED_ARTIFACT_KEYS.filter((key) => !(key in state.artifacts));
    if (missingKeys.length > 0) {
      throw new Error(`Missing required artifacts: ${missingKeys.join(", ")}`);
    }

    const mockMode =
      ["1", "true"].includes(String(process.env.JAP_MOCK_MODE ?? "").toLowerCase()) ||
      state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;

    if (mockMode) {
      const result = runMockReview(state);
      if (result.passed) {
        emitLogAdded("SUCCESS", REVIEW_NODE_LOG_TEXT.passedTitle, REVIEW_NODE_LOG_TEXT.passedMockSummary);
        return { errors: [] };
      }
      emitLogAdded("ERROR", REVIEW_NODE_LOG_TEXT.failedTitle, result.validationErrors.join(" | "));
      return { errors: [...state.errors, ...result.validationErrors] };
    }

    if (!state.llmConfig?.apiKey) {
      throw new Error("llmConfig.apiKey is required for review validation.");
    }

    const model = new ChatOpenAI({
      model: state.llmConfig?.modelName || "deepseek-chat",
      apiKey: state.llmConfig?.apiKey,
      configuration: {
        baseURL: state.llmConfig?.baseUrl || "https://api.deepseek.com",
      },
      temperature: 0.0,
      timeout: 20000,
      maxRetries: 0,
    });

    const structuredModel = model.withStructuredOutput(ReviewOutputSchema, {
      method: "functionCalling",
    });
    const skillContext = await loadSkillContext(state.workspaceConfig?.path);

    const result = await structuredModel.invoke([
      new SystemMessage(REVIEW_NODE_SYSTEM_PROMPT),
      new HumanMessage(
        [
          "Cross-review these four artifacts:",
          "",
          `### ${ARTIFACT_FILES.modeling01}`,
          state.artifacts[ARTIFACT_FILES.modeling01],
          "",
          `### ${ARTIFACT_FILES.modeling02}`,
          state.artifacts[ARTIFACT_FILES.modeling02],
          "",
          `### ${ARTIFACT_FILES.modeling03}`,
          state.artifacts[ARTIFACT_FILES.modeling03],
          "",
          `### ${ARTIFACT_FILES.modeling04}`,
          state.artifacts[ARTIFACT_FILES.modeling04],
          "",
          "Skill context:",
          skillContext || "(none)",
        ].join("\n"),
      ),
    ]);

    if (result.passed) {
      emitLogAdded("SUCCESS", REVIEW_NODE_LOG_TEXT.passedTitle, REVIEW_NODE_LOG_TEXT.passedSummary);
      return { errors: [] };
    }

    emitLogAdded("ERROR", REVIEW_NODE_LOG_TEXT.failedTitle, result.validationErrors.join(" | "));
    return {
      errors: [...state.errors, ...result.validationErrors],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLogAdded("ERROR", REVIEW_NODE_LOG_TEXT.failedTitle, message);
    return {
      errors: [...state.errors, `Review node failed: ${message}`],
    };
  }
}
