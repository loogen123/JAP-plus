import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { QUESTION_DIMENSIONS } from "../constants/domainConstants.js";
import { ELICITATION_NODE_LOG_TEXT } from "../constants/logTexts.js";
import { ELICITATION_NODE_SYSTEM_PROMPT } from "../constants/promptTexts.js";
import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import { loadSkillContext } from "../runtime/skillContext.js";
import { QuestionnaireSchema, type JapState } from "../state/japState.js";

function getMockQuestionnaire() {
  return {
    questions: [
      {
        id: "Q1",
        dimension: QUESTION_DIMENSIONS.core,
        questionType: "single" as const,
        questionText: "Should the core order entity bind both tenant and store scopes?",
        options: ["Use tenant_id + store_id", "Use tenant_id only", "No isolation field"],
      },
      {
        id: "Q2",
        dimension: QUESTION_DIMENSIONS.state,
        questionType: "single" as const,
        questionText: "How should payment timeout orders be handled?",
        options: ["Auto cancel", "Manual confirmation then cancel", "Keep pending payment"],
      },
      {
        id: "Q3",
        dimension: QUESTION_DIMENSIONS.security,
        questionType: "multiple" as const,
        questionText: "Which admin permission model should be enabled by default?",
        options: ["RBAC", "ABAC", "Role allow-list"],
      },
      {
        id: "Q4",
        dimension: QUESTION_DIMENSIONS.dependency,
        questionType: "single" as const,
        questionText: "What is the preferred payment integration strategy?",
        options: ["WeChat Pay", "Alipay", "Dual-channel parallel"],
      },
      {
        id: "Q5",
        dimension: QUESTION_DIMENSIONS.core,
        questionType: "single" as const,
        questionText: "Should order items persist pricing snapshots?",
        options: ["Store full snapshot", "Store final price only", "No snapshot"],
      },
    ],
  };
}

function getFallbackQuestionnaire() {
  return {
    questions: [
      {
        id: "Q_CORE_1",
        dimension: QUESTION_DIMENSIONS.core,
        questionType: "single" as const,
        questionText: "What isolation strategy should be used for core business entities?",
        options: ["tenant_id + store_id", "tenant_id only", "No isolation field"],
      },
      {
        id: "Q_STATE_1",
        dimension: QUESTION_DIMENSIONS.state,
        questionType: "single" as const,
        questionText: "What is the default convergence strategy for timeout/failure in the core flow?",
        options: ["Auto rollback", "Move to manual handling", "Keep state and alert"],
      },
      {
        id: "Q_SEC_1",
        dimension: QUESTION_DIMENSIONS.security,
        questionType: "multiple" as const,
        questionText: "Which security mechanisms must be enabled by default?",
        options: ["RBAC", "Audit logs", "Sensitive-field masking", "Critical action confirmation"],
      },
      {
        id: "Q_DEP_1",
        dimension: QUESTION_DIMENSIONS.dependency,
        questionType: "single" as const,
        questionText: "What is the preferred strategy when external services are unavailable?",
        options: ["Fail fast and retry", "Local fallback logic", "Async compensation"],
      },
    ],
  };
}

export async function generateQuestionnaire(state: JapState): Promise<Partial<JapState>> {
  emitStageChanged("DISCOVERY");
  emitLogAdded("INFO", ELICITATION_NODE_LOG_TEXT.startTitle, ELICITATION_NODE_LOG_TEXT.startSummary);

  if (state.questionnaire) {
    emitLogAdded("SUCCESS", ELICITATION_NODE_LOG_TEXT.skipTitle, ELICITATION_NODE_LOG_TEXT.skipSummary);
    return {
      questionnaire: state.questionnaire,
      errors: [],
    };
  }

  if (!state.originalRequirement.trim()) {
    const message = "originalRequirement cannot be empty when generating questionnaire.";
    emitLogAdded("ERROR", ELICITATION_NODE_LOG_TEXT.errorTitle, message);
    return {
      errors: [...state.errors, message],
    };
  }

  const mockMode =
    ["1", "true"].includes(String(process.env.JAP_MOCK_MODE ?? "").toLowerCase()) ||
    state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;
  if (mockMode) {
    emitLogAdded("SUCCESS", ELICITATION_NODE_LOG_TEXT.doneTitle, ELICITATION_NODE_LOG_TEXT.doneMockSummary);
    return {
      questionnaire: getMockQuestionnaire(),
      errors: [],
    };
  }

  if (!state.llmConfig?.apiKey) {
    const message = "llmConfig.apiKey is required for questionnaire generation.";
    emitLogAdded("ERROR", ELICITATION_NODE_LOG_TEXT.errorTitle, message);
    return {
      errors: [...state.errors, message],
    };
  }

  try {
    const skillContext = await loadSkillContext(state.workspaceConfig?.path);
    const model = new ChatOpenAI({
      model: state.llmConfig?.modelName || "deepseek-chat",
      apiKey: state.llmConfig?.apiKey,
      configuration: {
        baseURL: state.llmConfig?.baseUrl || "https://api.deepseek.com",
      },
      temperature: 0.1,
      timeout: 12000,
      maxRetries: 0,
    });

    const structuredModel = model.withStructuredOutput(QuestionnaireSchema, {
      method: "functionCalling",
    });

    const questionnaire = await structuredModel.invoke([
      new SystemMessage(ELICITATION_NODE_SYSTEM_PROMPT),
      new HumanMessage(
        [
          "Generate questionnaire from originalRequirement:",
          state.originalRequirement,
          "",
          "Skill context:",
          skillContext || "(none)",
        ].join("\n"),
      ),
    ]);

    emitLogAdded("SUCCESS", ELICITATION_NODE_LOG_TEXT.doneTitle, ELICITATION_NODE_LOG_TEXT.doneSummary);
    return { questionnaire, errors: [] };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown questionnaire generation error.";
    emitLogAdded(
      "ERROR",
      ELICITATION_NODE_LOG_TEXT.errorTitle,
      `${message}${ELICITATION_NODE_LOG_TEXT.fallbackSuffix}`,
    );
    return {
      questionnaire: getFallbackQuestionnaire(),
      errors: [],
    };
  }
}
