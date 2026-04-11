import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { loadSkillContext } from "../runtime/skillContext.js";
import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import { ModelingOutputSchema, type JapState } from "../state/japState.js";

const MODELING_SYSTEM_PROMPT = `
You are a top-tier AI software architect.
Generate exactly 4 hardcore engineering blueprints from the user's requirement and questionnaire answers.

Hard constraints:
1. Output must strictly follow schema keys.
2. Files 01-03 must contain valid Mermaid diagrams.
3. File 04 must be valid OpenAPI 3.0 YAML.
4. No explanatory text outside file content.
`.trim();

function compactModelingInput(state: JapState): string {
  const questions = state.questionnaire?.questions ?? [];
  const qaLines = questions
    .map((q) => {
      const answer = state.userAnswers[q.id];
      const answerText = Array.isArray(answer)
        ? answer.join(" | ")
        : String(answer ?? "");
      return [
        `QID: ${q.id}`,
        `DIM: ${q.dimension}`,
        `Q: ${q.questionText}`,
        `A: ${answerText || "N/A"}`,
      ].join("\n");
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

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          (item as { type?: string }).type === "text" &&
          "text" in item
        ) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function getMockModelingArtifacts() {
  return {
    "01_\u4ea7\u54c1\u529f\u80fd\u8111\u56fe\u4e0e\u7528\u4f8b.md": [
      "# 产品功能脑图与用例",
      "",
      "```mermaid",
      "mindmap",
      "  root((多租户扫码点餐))",
      "    用户端",
      "      扫码点餐",
      "      下单支付",
      "    商家端",
      "      菜单管理",
      "      订单处理",
      "```",
      "",
      "- UC01 创建订单",
      "- UC02 支付回调",
      "- UC03 查询订单",
    ].join("\n"),
    "02_\u9886\u57df\u6a21\u578b\u4e0e\u7269\u7406\u8868\u7ed3\u6784.md": [
      "# 领域模型与物理表结构",
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
    "03_\u6838\u5fc3\u4e1a\u52a1\u72b6\u6001\u673a.md": [
      "# 核心业务状态机",
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
    "04_RESTful_API\u5951\u7ea6.yaml": [
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

export async function modelingNode(
  state: JapState,
): Promise<Partial<JapState>> {
  emitStageChanged("MODELING");
  emitLogAdded("INFO", "建模启动", "开始生成 01-04 核心工程图纸。");

  if (!state.originalRequirement.trim()) {
    const message = "originalRequirement cannot be empty when modeling artifacts.";
    emitLogAdded("ERROR", "建模失败", message);
    return {
      errors: [...state.errors, message],
    };
  }

  const mockMode =
    ["1", "true"].includes(String(process.env.JAP_MOCK_MODE ?? "").toLowerCase()) ||
    state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;
  if (mockMode) {
    emitLogAdded("SUCCESS", "建模完成", "Mock 模式已生成 01-04 图纸。");
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
    emitLogAdded("ERROR", "建模失败", message);
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
    let result: ReturnType<typeof ModelingOutputSchema.parse>;
    try {
      result = await structuredModel.invoke([
        new SystemMessage(MODELING_SYSTEM_PROMPT),
        new HumanMessage(
          [
            modelingInput,
            "",
            "Skill context:",
            skillContext || "(none)",
          ].join("\n"),
        ),
      ]);
    } catch (structuredError) {
      const fallbackMessage = await model.invoke([
        new SystemMessage(
          `${MODELING_SYSTEM_PROMPT}\nReturn a pure JSON object only with these exact keys: "01_产品功能脑图与用例.md", "02_领域模型与物理表结构.md", "03_核心业务状态机.md", "04_RESTful_API契约.yaml".`,
        ),
        new HumanMessage(
          [
            modelingInput,
            "",
            "Skill context:",
            skillContext || "(none)",
          ].join("\n"),
        ),
      ]);
      const rawText = extractTextFromMessageContent(fallbackMessage.content);
      const rawJson = extractJsonObject(rawText);
      if (!rawJson) {
        throw structuredError;
      }
      let parsedRaw: unknown;
      try {
        parsedRaw = JSON.parse(rawJson);
      } catch {
        throw structuredError;
      }
      const parsed = ModelingOutputSchema.safeParse(parsedRaw);
      if (!parsed.success) {
        throw structuredError;
      }
      result = parsed.data;
      emitLogAdded("INFO", "建模回退", "已自动切换 JSON 解析模式完成建模。");
    }

    emitLogAdded("SUCCESS", "建模完成", "核心图纸 01-04 已生成。");
    return {
      artifacts: {
        ...state.artifacts,
        ...result,
      },
      errors: [],
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown modeling generation error.";
    emitLogAdded("ERROR", "建模失败", message);
    return {
      errors: [...state.errors, `Modeling node failed: ${message}`],
    };
  }
}
