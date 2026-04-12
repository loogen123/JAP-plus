import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { ARTIFACT_FILES } from "../constants/domainConstants.js";
import { MODELING_NODE_LOG_TEXT } from "../constants/logTexts.js";
import {
  MODELING_JSON_FALLBACK_PROMPT_SUFFIX,
  MODELING_NODE_SYSTEM_PROMPT,
} from "../constants/promptTexts.js";
import { loadSkillContext } from "../runtime/skillContext.js";
import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import { invokeStructuredWithJsonFallback } from "../services/structuredOutputFallback.js";
import { ModelingOutputSchema, type JapState } from "../state/japState.js";

function compactModelingInput(state: JapState): string {
  const questions = state.questionnaire?.questions ?? [];
  const qaLines = questions
    .map((q) => {
      const answer = state.userAnswers[q.id];
      const answerText = Array.isArray(answer) ? answer.join(" | ") : String(answer ?? "");
      return [`QID: ${q.id}`, `DIM: ${q.dimension}`, `Q: ${q.questionText}`, `A: ${answerText || "N/A"}`].join("\n");
    })
    .join("\n---\n");

  return [
    "Generate 4 modeling artifacts from:",
    "originalRequirement:",
    state.originalRequirement,
    "",
    "Question/Answer Snapshot:",
    qaLines,
  ].join("\n");
}

function getMockModelingArtifacts() {
  return {
    [ARTIFACT_FILES.modeling01]: [
      "# Product Mindmap and Use Cases",
      "",
      "```mermaid",
      "mindmap",
      "  root((Multi-tenant QR Ordering))",
      "    User",
      "      Scan and order",
      "      Pay order",
      "    Merchant",
      "      Menu management",
      "      Order handling",
      "```",
      "",
      "- UC01 Create order",
      "- UC02 Payment callback",
      "- UC03 Query order",
    ].join("\n"),
    [ARTIFACT_FILES.modeling02]: [
      "# Domain Model and Physical Schema",
      "",
      "```mermaid",
      "erDiagram",
      "  TENANT ||--o{ STORE : owns",
      "  STORE ||--o{ ORDER : creates",
      "  ORDER ||--o{ ORDER_ITEM : contains",
      "```",
      "",
      "- orders(id, tenant_id, store_id, status, total_amount)",
      "- order_items(id, order_id, menu_item_id, qty)",
    ].join("\n"),
    [ARTIFACT_FILES.modeling03]: [
      "# Core Business State Machine",
      "",
      "```mermaid",
      "stateDiagram-v2",
      "  [*] --> PENDING_PAYMENT",
      "  PENDING_PAYMENT --> PAID",
      "  PAID --> PREPARING",
      "  PREPARING --> READY",
      "  READY --> COMPLETED",
      "```",
    ].join("\n"),
    [ARTIFACT_FILES.modeling04]: [
      "openapi: 3.0.3",
      "info:",
      "  title: J-AP Plus Ordering API",
      "  version: 1.0.0",
      "paths:",
      "  /api/v1/orders:",
      "    post:",
      "      responses:",
      "        '201':",
      "          description: Created",
      "components:",
      "  schemas:",
      "    Order:",
      "      type: object",
      "      properties:",
      "        id: { type: string }",
      "        tenantId: { type: string }",
    ].join("\n"),
  };
}

export async function modelingNode(state: JapState): Promise<Partial<JapState>> {
  emitStageChanged("SOLUTION_DESIGN");
  emitLogAdded("INFO", MODELING_NODE_LOG_TEXT.startTitle, MODELING_NODE_LOG_TEXT.startSummary);

  if (!state.originalRequirement.trim()) {
    const message = "originalRequirement cannot be empty when modeling artifacts.";
    emitLogAdded("ERROR", MODELING_NODE_LOG_TEXT.errorTitle, message);
    return {
      errors: [...state.errors, message],
    };
  }

  const mockMode =
    ["1", "true"].includes(String(process.env.JAP_MOCK_MODE ?? "").toLowerCase()) ||
    state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;
  if (mockMode) {
    emitLogAdded("SUCCESS", MODELING_NODE_LOG_TEXT.doneTitle, MODELING_NODE_LOG_TEXT.doneMockSummary);
    return {
      artifacts: {
        ...state.artifacts,
        ...getMockModelingArtifacts(),
      },
      errors: [],
    };
  }

  if (!state.llmConfig?.apiKey) {
    const message = "llmConfig.apiKey is required for modeling generation.";
    emitLogAdded("ERROR", MODELING_NODE_LOG_TEXT.errorTitle, message);
    return {
      errors: [...state.errors, message],
    };
  }

  try {
    const model = new ChatOpenAI({
      model: state.llmConfig?.modelName || "deepseek-chat",
      apiKey: state.llmConfig?.apiKey,
      configuration: {
        baseURL: state.llmConfig?.baseUrl || "https://api.deepseek.com",
      },
      temperature: 0.1,
      timeout: 45000,
      maxRetries: 0,
    });

    const structuredModel = model.withStructuredOutput(ModelingOutputSchema, {
      method: "functionCalling",
    });
    const modelingInput = compactModelingInput(state);
    const skillContext = await loadSkillContext(state.workspaceConfig?.path);

    const { result, usedFallback } = await invokeStructuredWithJsonFallback({
      invokeStructured: () =>
        structuredModel.invoke([
          new SystemMessage(MODELING_NODE_SYSTEM_PROMPT),
          new HumanMessage([modelingInput, "", "Skill context:", skillContext || "(none)"].join("\n")),
        ]),
      invokeFallback: () =>
        model.invoke([
          new SystemMessage(`${MODELING_NODE_SYSTEM_PROMPT}\n${MODELING_JSON_FALLBACK_PROMPT_SUFFIX}`),
          new HumanMessage([modelingInput, "", "Skill context:", skillContext || "(none)"].join("\n")),
        ]),
      safeParse: (value) => ModelingOutputSchema.safeParse(value),
    });

    if (usedFallback) {
      emitLogAdded("INFO", MODELING_NODE_LOG_TEXT.fallbackTitle, MODELING_NODE_LOG_TEXT.fallbackSummary);
    }

    emitLogAdded("SUCCESS", MODELING_NODE_LOG_TEXT.doneTitle, MODELING_NODE_LOG_TEXT.doneSummary);
    return {
      artifacts: {
        ...state.artifacts,
        ...result,
      },
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown modeling generation error.";
    emitLogAdded("ERROR", MODELING_NODE_LOG_TEXT.errorTitle, message);
    return {
      errors: [...state.errors, `Modeling node failed: ${message}`],
    };
  }
}
