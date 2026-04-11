import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { loadSkillContext } from "../runtime/skillContext.js";
import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import { DetailingOutputSchema, type JapState } from "../state/japState.js";

const REQUIRED_BASE_ARTIFACT_KEYS = [
  "01_\u4ea7\u54c1\u529f\u80fd\u8111\u56fe\u4e0e\u7528\u4f8b.md",
  "02_\u9886\u57df\u6a21\u578b\u4e0e\u7269\u7406\u8868\u7ed3\u6784.md",
  "03_\u6838\u5fc3\u4e1a\u52a1\u72b6\u6001\u673a.md",
  "04_RESTful_API\u5951\u7ea6.yaml",
] as const;

const DETAILING_SYSTEM_PROMPT = `
You are a full-stack architect.
Based on the first 4 engineering artifacts, generate the final 3 deliverables.

Hard constraints:
1. 05 must use Gherkin Given/When/Then style test cases.
2. 06 must be a complete single-file HTML prototype with Tailwind CSS.
3. 07 must be a valid Postman Collection v2.1.0 JSON that covers APIs defined in 04.
4. Return strictly schema fields with no extra explanation.
`.trim();

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

function getMockDetailingArtifacts() {
  return {
    "05_\u884c\u4e3a\u9a71\u52a8\u9a8c\u6536\u6d4b\u8bd5.md": [
      "# 验收测试大纲",
      "",
      "Feature: 多租户扫码点餐",
      "Scenario: 用户下单",
      "Given 租户和门店已初始化",
      "When 用户提交订单",
      "Then 订单进入 PENDING_PAYMENT 状态",
    ].join("\n"),
    "06_UI\u539f\u578b\u4e0e\u4ea4\u4e92\u8349\u56fe.html": [
      "<!doctype html>",
      "<html lang=\"zh-CN\">",
      "<head>",
      "  <meta charset=\"UTF-8\" />",
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
      "  <title>J-AP Plus UI Prototype</title>",
      "  <script src=\"https://cdn.tailwindcss.com\"></script>",
      "</head>",
      "<body class=\"bg-slate-100 p-6\">",
      "  <div class=\"mx-auto max-w-4xl rounded-2xl bg-white p-6 shadow\">",
      "    <h1 class=\"text-2xl font-bold\">扫码点餐后台原型</h1>",
      "    <p class=\"mt-2 text-sm text-slate-600\">订单流转、支付、履约可视化面板。</p>",
      "  </div>",
      "</body>",
      "</html>",
    ].join("\n"),
    "07_API\u8c03\u8bd5\u96c6\u5408.json": JSON.stringify(
      {
        info: {
          name: "J-AP Plus API Collection",
          schema:
            "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
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

export async function detailingNode(
  state: JapState,
): Promise<Partial<JapState>> {
  emitStageChanged("DETAILING");
  emitLogAdded("INFO", "细化交付启动", "开始生成 05-07 细节交付物。");

  try {
    const missingKeys = REQUIRED_BASE_ARTIFACT_KEYS.filter(
      (key) => !(key in state.artifacts),
    );

    if (missingKeys.length > 0) {
      throw new Error(
        `Missing base artifacts for detailing: ${missingKeys.join(", ")}`,
      );
    }

    const mockMode =
      ["1", "true"].includes(
        String(process.env.JAP_MOCK_MODE ?? "").toLowerCase(),
      ) || state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;
    if (mockMode) {
      emitLogAdded("SUCCESS", "细化交付完成", "Mock 模式已生成 05-07 图纸。");
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
      "### 01_产品功能脑图与用例.md",
      state.artifacts["01_\u4ea7\u54c1\u529f\u80fd\u8111\u56fe\u4e0e\u7528\u4f8b.md"],
      "",
      "### 02_领域模型与物理表结构.md",
      state.artifacts["02_\u9886\u57df\u6a21\u578b\u4e0e\u7269\u7406\u8868\u7ed3\u6784.md"],
      "",
      "### 03_核心业务状态机.md",
      state.artifacts["03_\u6838\u5fc3\u4e1a\u52a1\u72b6\u6001\u673a.md"],
      "",
      "### 04_RESTful_API契约.yaml",
      state.artifacts["04_RESTful_API\u5951\u7ea6.yaml"],
    ].join("\n");
    const skillContext = await loadSkillContext(state.workspaceConfig?.path);
    let result: ReturnType<typeof DetailingOutputSchema.parse>;
    try {
      result = await structuredModel.invoke([
        new SystemMessage(DETAILING_SYSTEM_PROMPT),
        new HumanMessage(
          [
            detailingInput,
            "",
            "Skill context:",
            skillContext || "(none)",
          ].join("\n"),
        ),
      ]);
    } catch (structuredError) {
      const fallbackMessage = await model.invoke([
        new SystemMessage(
          `${DETAILING_SYSTEM_PROMPT}\nReturn a pure JSON object only with these exact keys: "05_行为驱动验收测试.md", "06_UI原型与交互草图.html", "07_API调试集合.json".`,
        ),
        new HumanMessage(
          [
            detailingInput,
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
      const parsed = DetailingOutputSchema.safeParse(parsedRaw);
      if (!parsed.success) {
        throw structuredError;
      }
      result = parsed.data;
      emitLogAdded("INFO", "细化回退", "已自动切换 JSON 解析模式完成细化交付。");
    }

    emitLogAdded("SUCCESS", "细化交付完成", "细节交付物 05-07 已生成。");
    return {
      artifacts: {
        ...state.artifacts,
        ...result,
      },
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLogAdded("ERROR", "细化交付失败", message);
    return {
      errors: [...state.errors, `Detailing node failed: ${message}`],
    };
  }
}
