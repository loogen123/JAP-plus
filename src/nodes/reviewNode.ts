import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import type { JapState } from "../state/japState.js";

export const ReviewOutputSchema = z.object({
  passed: z.boolean().describe("是否通过了所有严格的交叉验证"),
  validationErrors: z
    .array(z.string())
    .describe(
      "如果不通过，列出具体的逻辑冲突或错误原因（如果通过则为空数组）",
    ),
});

const REQUIRED_ARTIFACT_KEYS = [
  "01_\u4ea7\u54c1\u529f\u80fd\u8111\u56fe\u4e0e\u7528\u4f8b.md",
  "02_\u9886\u57df\u6a21\u578b\u4e0e\u7269\u7406\u8868\u7ed3\u6784.md",
  "03_\u6838\u5fc3\u4e1a\u52a1\u72b6\u6001\u673a.md",
  "04_RESTful_API\u5951\u7ea6.yaml",
] as const;

const REVIEW_SYSTEM_PROMPT = `
You are an extremely strict software QA architect.
Your only mission is to cross-validate hallucination conflicts across generated artifacts.

Must check:
1. Whether request/response fields used in artifact 04 OpenAPI exist in artifact 02 domain model.
2. Whether artifact 03 state machine transition boundaries cover all core use cases in artifact 01.

If any undefined entity, field mismatch, or logic gap exists, set passed=false and list all conflicts in validationErrors.
If perfect, set passed=true and validationErrors=[].
Only return schema-compliant JSON.
`.trim();

function runMockReview(state: JapState): z.infer<typeof ReviewOutputSchema> {
  const errors: string[] = [];

  const useCases =
    state.artifacts["01_\u4ea7\u54c1\u529f\u80fd\u8111\u56fe\u4e0e\u7528\u4f8b.md"] ?? "";
  const domainModel =
    state.artifacts["02_\u9886\u57df\u6a21\u578b\u4e0e\u7269\u7406\u8868\u7ed3\u6784.md"] ?? "";
  const stateMachine =
    state.artifacts["03_\u6838\u5fc3\u4e1a\u52a1\u72b6\u6001\u673a.md"] ?? "";
  const openapi = state.artifacts["04_RESTful_API\u5951\u7ea6.yaml"] ?? "";

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
  emitStageChanged("REVIEW");
  emitLogAdded("INFO", "交叉审查启动", "开始执行图纸一致性校验。");

  try {
    const missingKeys = REQUIRED_ARTIFACT_KEYS.filter(
      (key) => !(key in state.artifacts),
    );

    if (missingKeys.length > 0) {
      throw new Error(`Missing required artifacts: ${missingKeys.join(", ")}`);
    }

    const mockMode =
      ["1", "true"].includes(
        String(process.env.JAP_MOCK_MODE ?? "").toLowerCase(),
      ) || state.llmConfig?.apiKey?.toLowerCase().startsWith("mock") === true;

    if (mockMode) {
      const result = runMockReview(state);
      if (result.passed) {
        emitLogAdded("SUCCESS", "交叉审查通过", "Mock 校验通过，进入下一阶段。");
        return { errors: [] };
      }
      emitLogAdded("ERROR", "交叉审查失败", result.validationErrors.join(" | "));
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

    const structuredModel = model.withStructuredOutput(ReviewOutputSchema);

    const result = await structuredModel.invoke([
      new SystemMessage(REVIEW_SYSTEM_PROMPT),
      new HumanMessage(
        [
          "Cross-review these four artifacts:",
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
        ].join("\n"),
      ),
    ]);

    if (result.passed) {
      emitLogAdded("SUCCESS", "交叉审查通过", "图纸无冲突，允许进入细化阶段。");
      return { errors: [] };
    }

    emitLogAdded("ERROR", "交叉审查失败", result.validationErrors.join(" | "));
    return {
      errors: [...state.errors, ...result.validationErrors],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLogAdded("ERROR", "交叉审查失败", message);
    return {
      errors: [...state.errors, `Review node failed: ${message}`],
    };
  }
}
