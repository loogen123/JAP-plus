import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { QUESTION_DIMENSIONS } from "../constants/domainConstants.js";
import {
  API_ELICITATION_PROMPT,
  API_FINALIZE_PROMPT,
  DEEP_THINKING_SYSTEM_PROMPT,
} from "../constants/promptTexts.js";
import { loadSkillContext } from "../runtime/skillContext.js";
import { QuestionnaireSchema, QuestionSchema } from "../state/japState.js";
import { JapMcpClient } from "../tools/mcpClient.js";
import {
  buildQuestionSignature,
  dedupeQuestions,
  normalizePrdDraft,
  stringifyAnswer,
} from "../services/elicitationHelpers.js";

const ClarificationContextSchema = z.object({
  refinedRequirement: z.string().optional(),
  previousRounds: z
    .array(
      z.object({
        round: z.number().int().min(1),
        questions: z.array(QuestionSchema),
      }),
    )
    .optional(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});

const ClarificationPlanSchema = z.object({
  clarityReached: z.boolean().describe("Whether requirement clarity is sufficient to proceed to modeling."),
  refinedRequirement: z.string().describe("Best refined requirement at current stage."),
  questionnaire: z
    .object({
      questions: z.array(QuestionSchema).max(100),
    })
    .describe("When clarityReached=false, return next batch questions; otherwise empty array."),
});

const FinalRequirementSchema = z.object({
  finalRequirement: z.string().describe("Final requirement document merged from requirement and answers."),
});

type ClarificationQuestion = z.infer<typeof QuestionSchema>;
type ClarificationContext = z.infer<typeof ClarificationContextSchema>;
type DraftFiles = {
  runId: string;
  statusPath: string;
  rawPath: string;
  normalizedPath: string;
  inputPath: string;
  finalPath: string;
};

const FAST_ELICITATION_TIMEOUT_MS = 90000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`${label} timeout`));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function clampText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return input.slice(0, maxChars);
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeQuestionnaireInput(input: unknown): z.infer<typeof QuestionnaireSchema> {
  const normalized = Array.isArray(input) ? { questions: input } : input;
  const parsed = QuestionnaireSchema.safeParse(normalized ?? { questions: [] });
  if (parsed.success) {
    return parsed.data;
  }
  return { questions: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

async function readProjectContextLocal(projectRoot: string): Promise<string> {
  const targetFiles = ["package.json", "README.md", "pom.xml", ".jap-skills.md"];
  const contents: string[] = [];
  for (const file of targetFiles) {
    try {
      const filePath = path.join(projectRoot, file);
      const raw = await readFile(filePath, "utf-8");
      const text = raw.trim();
      if (text) {
        contents.push(`--- ${file} ---\n${text}\n`);
      }
    } catch {
      continue;
    }
  }
  return contents.join("\n");
}

function buildFallbackQuestionnaire(): ClarificationQuestion[] {
  return [
    {
      id: "Q_CORE_1",
      dimension: QUESTION_DIMENSIONS.core,
      questionType: "single",
      questionText: "核心实体是否需要使用租户（Tenant）和门店（Store）级别的隔离？",
      options: ["需要租户和门店双重隔离", "仅需要租户隔离", "不需要隔离字段"],
    },
    {
      id: "Q_STATE_1",
      dimension: QUESTION_DIMENSIONS.state,
      questionType: "single",
      questionText: "对于超时或失败的流程，默认的收敛策略是什么？",
      options: ["自动回滚到初始状态", "转入人工处理队列", "保持当前状态并触发告警"],
    },
    {
      id: "Q_SEC_1",
      dimension: QUESTION_DIMENSIONS.security,
      questionType: "multiple",
      questionText: "系统默认需要开启哪些安全控制机制？",
      options: ["基于角色的权限控制 (RBAC)", "全链路审计日志", "敏感字段脱敏展示", "高危操作二次确认"],
    },
    {
      id: "Q_DEP_1",
      dimension: QUESTION_DIMENSIONS.dependency,
      questionType: "single",
      questionText: "当外部依赖系统宕机或无响应时，首选的降级策略是什么？",
      options: ["快速失败并提示重试", "使用本地缓存/默认值降级", "异步记录并稍后补偿"],
    },
  ];
}

function buildPrdMcpDiagnosis(params: {
  availableTools: string[];
  reason: string;
  attempted: boolean;
  toolName: string | null;
}) {
  const candidateTools = ["generate_prd", "create_prd", "build_prd", "enhance_prd_content"];
  const matchedTools = candidateTools.filter((name) => params.availableTools.includes(name));
  const hasMatchedTool = matchedTools.length > 0;
  const reason = params.reason || "";
  const reasonLower = reason.toLowerCase();

  const likelyNotInstalled =
    !hasMatchedTool &&
    (reasonLower.includes("not found") || reasonLower.includes("enoent") || reasonLower.includes("missing"));
  const likelyNetworkOrRegistry =
    reasonLower.includes("eai_again") ||
    reasonLower.includes("etimedout") ||
    reasonLower.includes("registry") ||
    reasonLower.includes("fetch");
  const likelyRuntimeFailure =
    hasMatchedTool && params.attempted && !params.toolName && !likelyNetworkOrRegistry;

  const hint = likelyNotInstalled
    ? "PRD MCP tool is unavailable. Install and verify npx startup first."
    : likelyNetworkOrRegistry
      ? "Possible network/proxy issue while fetching via npx. Consider local pre-install."
      : likelyRuntimeFailure
        ? "PRD MCP was called but returned empty result. Check input/output contract."
        : "PRD MCP status looks normal or fallback finalized locally.";

  return {
    candidateTools,
    matchedTools,
    hasMatchedTool,
    likelyNotInstalled,
    likelyNetworkOrRegistry,
    likelyRuntimeFailure,
    hint,
  };
}

async function writeFinalizeDraftFiles(params: {
  workspacePath: string;
  rawDraft: string | null;
  normalizedDraft: string | null;
  mcpStatusText: string;
  finalizeInput: Record<string, unknown>;
  finalRequirement?: string;
}): Promise<DraftFiles> {
  const runId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const draftDir = path.join(params.workspacePath, "_draft", runId);
  await mkdir(draftDir, { recursive: true });

  const statusPath = path.join(draftDir, "_mcp_status.txt");
  const rawPath = path.join(draftDir, "00_prd_mcp_raw.md");
  const normalizedPath = path.join(draftDir, "01_prd_mcp_normalized.md");
  const inputPath = path.join(draftDir, "02_finalize_input.json");
  const finalPath = path.join(draftDir, "03_final_requirement_fused.md");

  // 只写入最终生成的 PRD 产物，舍弃冗余的中间态文件
  if (params.finalRequirement) {
    await writeFile(finalPath, params.finalRequirement, "utf-8");
  }

  return { runId, statusPath, rawPath, normalizedPath, inputPath, finalPath };
}

import { WebSocketServer } from "ws";

function wssBroadcastElicitationResult(wss: WebSocketServer, result: any) {
  const msg = JSON.stringify({ type: "elicitation-result", payload: result });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

export function registerElicitationRoutes(app: Express, wss: WebSocketServer): void {
  app.post("/api/v1/elicitation/questionnaire", async (req, res) => {
    const requirement = String(req.body?.requirement ?? "").trim();
    const contextParse = ClarificationContextSchema.safeParse(req.body?.context ?? {});
    const context: ClarificationContext = contextParse.success ? contextParse.data : {};
    const llm = req.body?.llm ?? {};
    const elicitationMode =
      String(req.body?.elicitationMode ?? "quick").toLowerCase() === "deep" ? "deep" : "quick";
    const workspacePath = req.body?.workspace?.path
      ? path.resolve(String(req.body.workspace.path))
      : path.resolve(process.cwd());
    const batchSize = clampInteger(
      Number(req.body?.batchSize ?? (elicitationMode === "deep" ? 24 : 16)),
      5,
      30,
      16,
    );
    const targetTotal = clampInteger(Number(req.body?.targetTotal ?? 100), 1, 100, 100);
    const apiKey = String(llm.apiKey || "").trim();
    const baseUrl = String(llm.baseUrl || "https://api.deepseek.com");
    const modelName = String(llm.modelName || "deepseek-chat");

    if (!requirement) {
      res.status(400).json({ message: "requirement is required" });
      return;
    }

    if (!apiKey) {
      res.status(400).json({ message: "llm.apiKey is required" });
      return;
    }

    res.json({ accepted: true, message: "Elicitation started, result will be sent via WebSocket" });

    (async () => {
      try {
        const startedAt = Date.now();
        const hardDeadlineMs = elicitationMode === "deep" ? 180000 : 90000;

      const contextStartedAt = Date.now();
      const projectContextStr = await readProjectContextLocal(workspacePath);
      const skillContext = await loadSkillContext(workspacePath);
      const contextCostMs = Date.now() - contextStartedAt;

      let finalProjectContext = `${projectContextStr}\n${skillContext}`.trim();
      let deepThinkingCostMs = 0;

      if (elicitationMode === "deep") {
        try {
          const spentMs = Date.now() - startedAt;
          if (hardDeadlineMs - spentMs < 18000) {
            throw new Error("deadline reached");
          }
          const mcpClient = await JapMcpClient.getSharedClient(workspacePath);
          const seqThinking = await mcpClient.getSequentialThinkingTool();
          if (seqThinking) {
            const tools = [
              {
                type: "function",
                function: {
                  name: seqThinking.tool.name,
                  description: seqThinking.tool.description,
                  parameters: seqThinking.tool.inputSchema,
                },
              },
            ];

            const thinkModel = new ChatOpenAI({
              model: modelName,
              apiKey,
              configuration: { baseURL: baseUrl },
              temperature: 0.1,
              timeout: FAST_ELICITATION_TIMEOUT_MS,
              maxRetries: 0,
            }).bindTools(tools);

            const thinkingStartedAt = Date.now();
            const remainingMs = Math.max(5000, hardDeadlineMs - (Date.now() - startedAt) - 2000);
            const initialResponse = await withTimeout(
              thinkModel.invoke([
              new SystemMessage(DEEP_THINKING_SYSTEM_PROMPT),
              new HumanMessage(
                JSON.stringify({
                  originalRequirement: requirement,
                  refinedRequirement: context.refinedRequirement ?? "",
                  previousRounds: context.previousRounds ?? [],
                  answers: context.answers ?? {},
                  projectContext: projectContextStr,
                  skillContext,
                }),
              ),
              ]),
              remainingMs,
              "deep thinking",
            );

            if (Array.isArray(initialResponse.tool_calls)) {
              const firstCall = initialResponse.tool_calls[0];
              if (firstCall && firstCall.name === "sequentialthinking") {
                const args = isRecord(firstCall.args) ? firstCall.args : {};
                const toolResult = await seqThinking.client.callTool({
                  name: "sequentialthinking",
                  arguments: args,
                });
                finalProjectContext += `\n--- thinking trace ---\n${JSON.stringify(toolResult, null, 2)}`;
              }
            }

            deepThinkingCostMs = Date.now() - thinkingStartedAt;
          }
        } catch {
          deepThinkingCostMs = 0;
        }
      }

      finalProjectContext = clampText(finalProjectContext, 8000);

      const spentBeforeModelMs = Date.now() - startedAt;
      const remainingForStructuredMs = Math.max(8000, hardDeadlineMs - spentBeforeModelMs);

      const model = new ChatOpenAI({
        model: modelName,
        apiKey,
        configuration: { baseURL: baseUrl },
        temperature: 0.1,
        timeout: Math.min(FAST_ELICITATION_TIMEOUT_MS, remainingForStructuredMs),
        maxRetries: 0,
      });

      const structured = model.withStructuredOutput(ClarificationPlanSchema, {
        method: "functionCalling",
      });

      const payload = {
        originalRequirement: requirement,
        refinedRequirement: context.refinedRequirement ?? "",
        previousRounds: context.previousRounds ?? [],
        answers: context.answers ?? {},
        projectContext: finalProjectContext,
        skillContext,
        existingQuestionSignatures: (context.previousRounds ?? [])
          .flatMap((round) => round.questions ?? [])
          .map((question) => buildQuestionSignature(question))
          .slice(-300),
        batchSize,
        targetTotal,
        instruction:
          elicitationMode === "deep"
            ? "Use project context and thinking trace to generate next batch; output exactly batchSize items and cover missing dimensions first."
            : "Quickly generate next batch with high information density; output exactly batchSize and avoid duplicates.",
      };

      const structuredStartedAt = Date.now();
      const result = await withTimeout(
        structured.invoke([
          new SystemMessage(API_ELICITATION_PROMPT),
          new HumanMessage(JSON.stringify(payload, null, 2)),
        ]),
        remainingForStructuredMs,
        "elicitation",
      );

      const existingSignatures = new Set(
        (context.previousRounds ?? [])
          .flatMap((round) => round.questions ?? [])
          .map((question) => buildQuestionSignature(question)),
      );
      const deduped = dedupeQuestions(result.questionnaire?.questions ?? [], existingSignatures, batchSize);

      const normalizedResult = {
        ...result,
        questionnaire: {
          questions: deduped.questions,
        },
      };

      const structuredCostMs = Date.now() - structuredStartedAt;
      const totalCostMs = Date.now() - startedAt;

      wssBroadcastElicitationResult(wss, {
        ...normalizedResult,
        meta: {
          elicitationMode,
          timingMs: {
            context: contextCostMs,
            deepThinking: deepThinkingCostMs,
            structured: structuredCostMs,
            total: totalCostMs,
          },
          batch: {
            batchSize,
            targetTotal,
            returned: normalizedResult.questionnaire.questions.length,
            droppedAsDuplicate: deduped.dropped,
          },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      wssBroadcastElicitationResult(wss, {
        clarityReached: false,
        refinedRequirement: requirement,
        questionnaire: { questions: buildFallbackQuestionnaire() },
        fallback: true,
        fallbackReason: message,
        meta: {
          elicitationMode,
        },
      });
    }
    })();
  });

  app.post("/api/v1/elicitation/finalize", async (req, res) => {
    const requirement = String(req.body?.requirement ?? "").trim();
    const questionnaire = normalizeQuestionnaireInput(req.body?.questionnaire);
    const answers = isRecord(req.body?.answers) ? req.body.answers : {};
    const llm = req.body?.llm ?? {};
    const workspacePath = req.body?.workspace?.path
      ? path.resolve(String(req.body.workspace.path))
      : path.resolve(process.cwd());
    const apiKey = String(llm.apiKey || "").trim();
    const baseUrl = String(llm.baseUrl || "https://api.deepseek.com");
    const modelName = String(llm.modelName || "deepseek-chat");
    const persistDraft = req.body?.persistDraft === false ? false : true;

    if (!requirement) {
      res.status(400).json({ message: "requirement is required" });
      return;
    }

    if (!apiKey) {
      res.status(400).json({ message: "llm.apiKey is required" });
      return;
    }

    try {
      let projectContextStr = "";
      let prdDraftRaw = "";
      let prdDraftNormalized = "";
      let prdDraftToolName: string | null = null;
      let prdMcpAvailable = false;
      let prdMcpAttempted = false;
      let prdMcpReason = "";
      let availableTools: string[] = [];
      let draftFiles: DraftFiles | null = null;

      try {
        const mcpClient = await JapMcpClient.getSharedClient(workspacePath);
        projectContextStr = await mcpClient.readProjectContext(workspacePath);
        availableTools = await mcpClient.listAvailableTools();

        const prdCandidates = mcpClient.getPrdToolCandidates();
        prdMcpAvailable = prdCandidates.some((name) => availableTools.includes(name));

        const topQuestions = questionnaire.questions
          .slice(0, 40)
          .map((question) => `${question.dimension}:${question.questionText}`);
        const topAnswers = Object.entries(answers)
          .slice(0, 40)
          .map(([key, value]) => `${key}:${stringifyAnswer(value)}`);

        if (prdMcpAvailable) {
          prdMcpAttempted = true;
          const prdDraft = await mcpClient.generatePrdDraft({
            productName: "JAP Final Requirement",
            productDescription: requirement,
            targetAudience: "Product managers, tech leads, dev team, and QA team",
            coreFeatures: topQuestions.length > 0 ? topQuestions : ["Generate complete requirement from questionnaire"],
            constraints: ["Output should be modeling-ready", "Boundary must be clear and executable"],
            additionalContext: ["Questionnaire answers:", ...topAnswers].join("\n"),
          });

          if (prdDraft?.draft) {
            prdDraftRaw = prdDraft.draft;
            prdDraftNormalized = normalizePrdDraft(prdDraft.draft);
            prdDraftToolName = prdDraft.toolName;
            prdMcpReason = `PRD draft generated through tool ${prdDraft.toolName}`;
          } else {
            prdMcpReason = "PRD MCP tool returned no effective draft text";
          }
        } else {
          prdMcpReason =
            "No PRD MCP tool detected (generate_prd/create_prd/build_prd/enhance_prd_content).";
        }
      } catch (mcpError) {
        console.error("Failed to read project context via MCP in finalize:", mcpError);
        prdMcpReason = `MCP call failed: ${mcpError instanceof Error ? mcpError.message : String(mcpError)}`;
      }

      const skillContext = await loadSkillContext(workspacePath);
      const prdMcpDiagnosis = buildPrdMcpDiagnosis({
        availableTools,
        reason: prdMcpReason,
        attempted: prdMcpAttempted,
        toolName: prdDraftToolName,
      });

      const finalizeInput = {
        originalRequirement: requirement,
        questionnaire,
        answers,
        projectContext: `${projectContextStr}\n${skillContext}`.trim(),
        skillContext,
        prdMcpAvailable,
        prdMcpAttempted,
        prdMcpReason,
        prdMcpDiagnosis,
        availableTools,
        prdDraftToolName,
        prdDraftRawLength: prdDraftRaw.length,
        prdDraftNormalizedLength: prdDraftNormalized.length,
        generatedAt: new Date().toISOString(),
      };

      if (persistDraft) {
        draftFiles = await writeFinalizeDraftFiles({
          workspacePath,
          rawDraft: prdDraftRaw || null,
          normalizedDraft: prdDraftNormalized || null,
          mcpStatusText: [
            `prdMcpAvailable: ${prdMcpAvailable}`,
            `prdMcpAttempted: ${prdMcpAttempted}`,
            `prdDraftToolName: ${prdDraftToolName ?? ""}`,
            `reason: ${prdMcpReason}`,
            `hint: ${prdMcpDiagnosis.hint}`,
            `availableTools: ${availableTools.join(", ")}`,
          ].join("\n"),
          finalizeInput,
        });
      }

      const model = new ChatOpenAI({
        model: modelName,
        apiKey,
        configuration: { baseURL: baseUrl },
        temperature: 0.2,
        timeout: 30000,
        maxRetries: 1,
      });

      const structured = model.withStructuredOutput(FinalRequirementSchema, {
        method: "functionCalling",
      });
      const result = await structured.invoke([
        new SystemMessage(API_FINALIZE_PROMPT),
        new HumanMessage(
          JSON.stringify(
            {
              originalRequirement: requirement,
              questionnaire,
              answers,
              projectContext: `${projectContextStr}\n${skillContext}`.trim(),
              skillContext,
              prdDraft: prdDraftNormalized,
              prdDraftToolName: prdDraftToolName ?? "",
              draftFiles,
            },
            null,
            2,
          ),
        ),
      ]);

      if (persistDraft && draftFiles?.finalPath) {
        await writeFile(draftFiles.finalPath, result.finalRequirement ?? "", "utf-8");
      }

      res.json({
        ...result,
        meta: {
          prdMcpAvailable,
          prdMcpAttempted,
          prdMcpReason,
          prdMcpDiagnosis,
          availableTools,
          prdDraftEnabled: Boolean(prdDraftNormalized),
          prdDraftToolName,
          persistDraft,
          draftFiles,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  });
}
