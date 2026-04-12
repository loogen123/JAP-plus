import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { ARTIFACT_FILES, MODELING_ARTIFACT_KEYS } from "../constants/domainConstants.js";
import { DETAILING_NODE_LOG_TEXT } from "../constants/logTexts.js";
import {
  DETAILING_JSON_FALLBACK_PROMPT_SUFFIX,
  DETAILING_NODE_SYSTEM_PROMPT,
} from "../constants/promptTexts.js";
import { loadSkillContext } from "../runtime/skillContext.js";
import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import { invokeStructuredWithJsonFallback } from "../services/structuredOutputFallback.js";
import { DetailingOutputSchema, type JapState } from "../state/japState.js";

const REQUIRED_BASE_ARTIFACT_KEYS = MODELING_ARTIFACT_KEYS;

function getMockDetailingArtifacts() {
  return {
    [ARTIFACT_FILES.detailing05]: [
      "# Acceptance Test Outline",
      "",
      "Feature: Multi-tenant QR ordering",
      "Scenario: User places order",
      "Given tenant and store are initialized",
      "When user submits an order",
      "Then order enters PENDING_PAYMENT state",
    ].join("\n"),
    [ARTIFACT_FILES.detailing06]: [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "  <meta charset=\"UTF-8\" />",
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
      "  <title>J-AP Plus UI Prototype</title>",
      "  <script src=\"https://cdn.tailwindcss.com\"></script>",
      "</head>",
      "<body class=\"bg-slate-100 p-6\">",
      "  <div class=\"mx-auto max-w-4xl rounded-2xl bg-white p-6 shadow\">",
      "    <h1 class=\"text-2xl font-bold\">Ordering Admin Prototype</h1>",
      "    <p class=\"mt-2 text-sm text-slate-600\">Visual panel for order flow, payment, and fulfillment.</p>",
      "  </div>",
      "</body>",
      "</html>",
    ].join("\n"),
    [ARTIFACT_FILES.detailing07]: JSON.stringify(
      {
        info: {
          name: "J-AP Plus API Collection",
          schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        item: [
          {
            name: "Create Order",
            request: {
              method: "POST",
              url: {
                raw: "{{baseUrl}}/api/v1/orders",
                host: ["{{baseUrl}}"],
                path: ["api", "v1", "orders"],
              },
            },
          },
        ],
      },
      null,
      2,
    ),
  };
}

export async function detailingNode(state: JapState): Promise<Partial<JapState>> {
  emitStageChanged("IMPLEMENTATION_BLUEPRINT");
  emitLogAdded("INFO", DETAILING_NODE_LOG_TEXT.startTitle, DETAILING_NODE_LOG_TEXT.startSummary);

  try {
    const missingKeys = REQUIRED_BASE_ARTIFACT_KEYS.filter((key) => !(key in state.artifacts));
    if (missingKeys.length > 0) {
      throw new Error(`Missing base artifacts for detailing: ${missingKeys.join(", ")}`);
    }

    const mockMode =
      ["1", "true"].includes(String(process.env.JAP_MOCK_MODE ?? "").toLowerCase()) ||
      state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;
    if (mockMode) {
      emitLogAdded("SUCCESS", DETAILING_NODE_LOG_TEXT.doneTitle, DETAILING_NODE_LOG_TEXT.doneMockSummary);
      return {
        artifacts: {
          ...state.artifacts,
          ...getMockDetailingArtifacts(),
        },
        errors: [],
      };
    }

    if (!state.llmConfig?.apiKey) {
      throw new Error("llmConfig.apiKey is required for detailing generation.");
    }

    const model = new ChatOpenAI({
      model: state.llmConfig?.modelName || "deepseek-chat",
      apiKey: state.llmConfig?.apiKey,
      configuration: {
        baseURL: state.llmConfig?.baseUrl || "https://api.deepseek.com",
      },
      temperature: 0.2,
      timeout: 45000,
      maxRetries: 0,
    });

    const structuredModel = model.withStructuredOutput(DetailingOutputSchema, {
      method: "functionCalling",
    });

    const detailingInput = [
      "Generate artifacts 05-07 from these base documents:",
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
    ].join("\n");

    const skillContext = await loadSkillContext(state.workspaceConfig?.path);

    const { result, usedFallback } = await invokeStructuredWithJsonFallback({
      invokeStructured: () =>
        structuredModel.invoke([
          new SystemMessage(DETAILING_NODE_SYSTEM_PROMPT),
          new HumanMessage([detailingInput, "", "Skill context:", skillContext || "(none)"].join("\n")),
        ]),
      invokeFallback: () =>
        model.invoke([
          new SystemMessage(`${DETAILING_NODE_SYSTEM_PROMPT}\n${DETAILING_JSON_FALLBACK_PROMPT_SUFFIX}`),
          new HumanMessage([detailingInput, "", "Skill context:", skillContext || "(none)"].join("\n")),
        ]),
      safeParse: (value) => DetailingOutputSchema.safeParse(value),
    });

    if (usedFallback) {
      emitLogAdded("INFO", DETAILING_NODE_LOG_TEXT.fallbackTitle, DETAILING_NODE_LOG_TEXT.fallbackSummary);
    }

    emitLogAdded("SUCCESS", DETAILING_NODE_LOG_TEXT.doneTitle, DETAILING_NODE_LOG_TEXT.doneSummary);
    return {
      artifacts: {
        ...state.artifacts,
        ...result,
      },
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLogAdded("ERROR", DETAILING_NODE_LOG_TEXT.errorTitle, message);
    return {
      errors: [...state.errors, `Detailing node failed: ${message}`],
    };
  }
}
