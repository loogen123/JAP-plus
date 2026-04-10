import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import { QuestionnaireSchema, type JapState } from "../state/japState.js";

const ELICITATION_SYSTEM_PROMPT = `
You are the J-AP Plus requirement elicitation engine.
Generate a strict disambiguation questionnaire from the user's original requirement.

Hard constraints:
- Return exactly 5 to 8 single-choice questions.
- Cover all 4 dimensions: "核心实体", "状态边界", "安全权限", "外部依赖".
- questionText must be implementation-critical and decision-ready.
- options must be 3 to 5 mutually exclusive choices.
- Return only the structured schema output.
`.trim();

function getMockQuestionnaire() {
  return {
    questions: [
      {
        id: "Q1",
        dimension: "\u6838\u5fc3\u5b9e\u4f53" as const,
        questionText: "核心订单主实体是否需要关联租户与门店？",
        options: ["是，强制 tenant_id + store_id", "仅 tenant_id", "不需要隔离字段"],
      },
      {
        id: "Q2",
        dimension: "\u72b6\u6001\u8fb9\u754c" as const,
        questionText: "支付超时订单状态如何处理？",
        options: ["自动取消", "人工确认后取消", "保留待支付"],
      },
      {
        id: "Q3",
        dimension: "\u5b89\u5168\u6743\u9650" as const,
        questionText: "后台运营权限模型采用哪种策略？",
        options: ["RBAC", "ABAC", "仅角色白名单"],
      },
      {
        id: "Q4",
        dimension: "\u5916\u90e8\u4f9d\u8d56" as const,
        questionText: "支付渠道优先接入方案？",
        options: ["微信支付", "支付宝", "双通道并行"],
      },
      {
        id: "Q5",
        dimension: "\u6838\u5fc3\u5b9e\u4f53" as const,
        questionText: "订单明细是否记录快照价与活动信息？",
        options: ["记录完整快照", "仅记录成交价", "不记录快照"],
      },
    ],
  };
}

export async function generateQuestionnaire(
  state: JapState,
): Promise<Partial<JapState>> {
  emitStageChanged("INTENT_ANALYSIS");
  emitLogAdded("INFO", "需求澄清启动", "开始生成结构化问卷。");

  if (!state.originalRequirement.trim()) {
    const message = "originalRequirement cannot be empty when generating questionnaire.";
    emitLogAdded("ERROR", "需求澄清失败", message);
    return {
      errors: [...state.errors, message],
    };
  }

  const mockMode =
    ["1", "true"].includes(String(process.env.JAP_MOCK_MODE ?? "").toLowerCase()) ||
    state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;
  if (mockMode) {
    emitLogAdded("SUCCESS", "需求澄清完成", "Mock 模式已生成问卷。");
    return {
      questionnaire: getMockQuestionnaire(),
      errors: [],
    };
  }

  if (!state.llmConfig?.apiKey) {
    const message = "llmConfig.apiKey is required for questionnaire generation.";
    emitLogAdded("ERROR", "需求澄清失败", message);
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
      temperature: 0.2,
      timeout: 20000,
      maxRetries: 0,
    });

    const structuredModel = model.withStructuredOutput(QuestionnaireSchema);

    const questionnaire = await structuredModel.invoke([
      new SystemMessage(ELICITATION_SYSTEM_PROMPT),
      new HumanMessage(
        [
          "Generate questionnaire from originalRequirement:",
          state.originalRequirement,
        ].join("\n"),
      ),
    ]);

    emitLogAdded("SUCCESS", "需求澄清完成", "问卷已生成。");
    return { questionnaire, errors: [] };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown questionnaire generation error.";
    emitLogAdded("ERROR", "需求澄清失败", message);
    return {
      errors: [...state.errors, `Questionnaire generation failed: ${message}`],
    };
  }
}
