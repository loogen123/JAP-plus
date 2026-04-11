import cors from "cors";
import express from "express";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { japApp } from "./workflow/japGraph.js";
import { JapMcpClient } from "./tools/mcpClient.js";
import { loadSkillContext } from "./runtime/skillContext.js";
import {
  beginTask,
  emitLogAdded,
  emitStageChanged,
  emitTaskFinished,
  endTask,
  setBroadcaster,
} from "./runtime/workflowEvents.js";
import type { JapState } from "./state/japState.js";

const execFileAsync = promisify(execFile);

const ClarificationQuestionSchema = z.object({
  id: z.string(),
  dimension: z.enum(["核心实体", "状态边界", "安全权限", "外部依赖"]),
  questionType: z.enum(["single", "multiple"]),
  questionText: z.string(),
  options: z.array(z.string()).min(2).max(8),
});

const ClarificationContextSchema = z.object({
  refinedRequirement: z.string().optional(),
  previousRounds: z
    .array(
      z.object({
        round: z.number().int().min(1),
        questions: z.array(ClarificationQuestionSchema),
      }),
    )
    .optional(),
  answers: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
});

const ClarificationPlanSchema = z.object({
  clarityReached: z.boolean().describe("是否已经足够清晰，可直接进入建模"),
  refinedRequirement: z
    .string()
    .describe("当前阶段整理后的需求文本（即使还需提问也应给出当前最佳版本）"),
  questionnaire: z.object({
    questions: z.array(ClarificationQuestionSchema).max(100)
  }).describe("若 clarityReached=false，则返回需要继续确认的问题列表；否则 questions 为空数组"),
});

const FinalRequirementSchema = z.object({
  finalRequirement: z
    .string()
    .describe("综合用户答案后的完整、明确、可执行需求文本"),
});

const ELICITATION_PROMPT = `
你是 J-AP Plus 的需求澄清引擎。
你的任务：基于用户原始需求生成澄清问卷，每次只输出当前批次需要的问题。

原则：
1. 只生成当前批次的问题，必须和已有问题去重，不要一次性输出全部题库。
2. 问题必须精准且具备工程深度，必须涵盖以下 4 个维度：
   - 核心实体：业务主对象及其关联关系。
   - 状态边界：核心流程的状态机流转及异常收敛。
   - 安全权限：RBAC 模型、数据可见性、审计要求等。
   - 外部依赖：三方接口、中间件集成、降级策略等。
3. 总题量上限 100 题；单次输出数量严格遵循 payload.batchSize。
4. 问题类型支持单选（single）或多选（multiple）。
5. 每题提供 2-8 个高质量选项，选项要具体、可执行、互斥或可组合。
6. 强烈依赖 payload 中的 projectContext（包括 package.json, README.md, .jap-skills.md 等）：
   - 如果上下文中有明确的架构规范或技术栈，不要再问已知信息。
   - 问题必须围绕项目已有实体和真实业务背景展开，拒绝空泛的通用问题。
   - 特别注意 .jap-skills.md 中的定制化技能和约束原则，其优先级最高。
7. 如果已有问题数已达到 payload.targetTotal 或信息足够，则 clarityReached=true 且本批 questionnaire.questions=[]。
8. 无论是否继续提问，都要给 refinedRequirement（当前阶段最佳需求文本）。
9. 只返回结构化结果，不要输出解释性废话。
10. 必须严格参照 payload.existingQuestionSignatures 去重；禁止仅改 id 或微调措辞后重复提问。
`.trim();

const FAST_ELICITATION_TIMEOUT_MS = 60000;

type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\r\n\t]+/g, "")
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()【】\[\]{}<>《》\-—_]/g, "");
}

function buildQuestionSignature(question: ClarificationQuestion): string {
  const optionSig = [...(question.options ?? [])]
    .map((item) => normalizeText(String(item)))
    .sort()
    .join("|");
  return [
    question.dimension,
    question.questionType,
    normalizeText(question.questionText ?? ""),
    optionSig,
  ].join("#");
}

function dedupeQuestions(
  questions: ClarificationQuestion[],
  existingSignatures: Set<string>,
  maxCount: number,
): { questions: ClarificationQuestion[]; dropped: number } {
  const out: ClarificationQuestion[] = [];
  let dropped = 0;
  const localSeen = new Set<string>();
  for (const item of questions) {
    const sig = buildQuestionSignature(item);
    const shortSig = `${item.dimension}#${item.questionType}#${normalizeText(item.questionText ?? "")}`;
    if (existingSignatures.has(sig) || existingSignatures.has(shortSig)) {
      dropped++;
      continue;
    }
    if (localSeen.has(sig) || localSeen.has(shortSig)) {
      dropped++;
      continue;
    }
    localSeen.add(sig);
    localSeen.add(shortSig);
    existingSignatures.add(sig);
    existingSignatures.add(shortSig);
    out.push(item);
    if (out.length >= maxCount) {
      break;
    }
  }
  return { questions: out, dropped };
}

function buildFallbackQuestionnaire(): ClarificationQuestion[] {
  return [
    {
      id: "Q_CORE_1",
      dimension: "核心实体",
      questionType: "single",
      questionText: "核心主实体应采用哪种组织隔离策略？",
      options: ["强隔离（tenant_id + store_id）", "仅租户隔离（tenant_id）", "无业务隔离字段"],
    },
    {
      id: "Q_STATE_1",
      dimension: "状态边界",
      questionType: "single",
      questionText: "主流程异常（超时/失败）的状态收敛策略是？",
      options: ["自动回滚到初始状态", "进入待人工处理状态", "保留原状态并记录告警"],
    },
    {
      id: "Q_SEC_1",
      dimension: "安全权限",
      questionType: "multiple",
      questionText: "以下哪些安全机制必须默认启用？（可多选）",
      options: ["RBAC 权限模型", "操作审计日志", "敏感字段脱敏", "关键操作二次确认"],
    },
    {
      id: "Q_DEP_1",
      dimension: "外部依赖",
      questionType: "single",
      questionText: "外部服务不可用时，系统优先策略是？",
      options: ["快速失败并提示重试", "降级到本地兜底逻辑", "异步补偿后最终一致"],
    },
  ];
}

const FINALIZE_PROMPT = `
你是 J-AP Plus 的需求定稿引擎。
请把“原始业务目标 + 澄清问卷 + 用户答案”融合成一份完整、明确、可直接用于系统建模的需求文档。

要求：
1. 不遗漏任何用户已选择答案。
2. 对未回答问题给出保守且合理的工程默认假设，并显式写入“默认假设”部分。
3. 输出必须清晰包含：目标、范围、核心对象、关键流程、权限与安全、外部依赖、约束条件、验收要点。
4. 参考提供的 projectContext，确保生成的需求与项目现有规范、技术栈及已有实体保持一致。
5. 如果提供 prdDraft，优先吸收其中结构化章节，但必须以 questionnaire 与 answers 为最终事实源。
6. 仅返回结构化结果。
`.trim();

function stringifyAnswer(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(" | ");
  }
  return String(value ?? "");
}

function normalizePrdDraft(rawDraft: string): string {
  return rawDraft
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPrdMcpDiagnosis(params: {
  availableTools: string[];
  reason: string;
  attempted: boolean;
  toolName: string | null;
}) {
  const candidateTools = [
    "generate_prd",
    "create_prd",
    "build_prd",
    "enhance_prd_content",
  ];
  const matchedTools = candidateTools.filter((name) =>
    params.availableTools.includes(name),
  );
  const hasMatchedTool = matchedTools.length > 0;
  const reason = params.reason || "";
  const reasonLower = reason.toLowerCase();
  const likelyNotInstalled =
    !hasMatchedTool &&
    (reason.includes("未检测到") ||
      reasonLower.includes("not found") ||
      reasonLower.includes("enoent"));
  const likelyNetworkOrRegistry =
    reasonLower.includes("eai_again") ||
    reasonLower.includes("etimedout") ||
    reasonLower.includes("registry") ||
    reasonLower.includes("fetch");
  const likelyRuntimeFailure =
    hasMatchedTool &&
    params.attempted &&
    !params.toolName &&
    !likelyNetworkOrRegistry;
  const hint = likelyNotInstalled
    ? "当前环境未提供 PRD MCP 工具；请先安装并确保可被 npx 启动。"
    : likelyNetworkOrRegistry
      ? "可能是网络/代理导致 npx 拉取失败；建议本地预装并离线运行。"
      : likelyRuntimeFailure
        ? "PRD MCP 已命中但返回空结果；请检查该 MCP 的入参与输出格式。"
        : "PRD MCP 状态正常或已回退本地定稿。";
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
}): Promise<{
  runId: string;
  statusPath: string;
  rawPath: string;
  normalizedPath: string;
  inputPath: string;
  finalPath: string;
}> {
  const runId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const draftDir = path.join(params.workspacePath, "_draft", runId);
  await mkdir(draftDir, { recursive: true });
  const statusPath = path.join(draftDir, "_mcp_status.txt");
  const rawPath = path.join(draftDir, "00_prd_mcp_raw.md");
  const normalizedPath = path.join(draftDir, "01_prd_mcp_normalized.md");
  const inputPath = path.join(draftDir, "02_finalize_input.json");
  const finalPath = path.join(draftDir, "03_final_requirement_fused.md");
  await writeFile(statusPath, params.mcpStatusText, "utf-8");
  await writeFile(
    rawPath,
    params.rawDraft ?? "# PRD MCP 未命中\n\n本次未获得专用 PRD MCP 草案输出。",
    "utf-8",
  );
  await writeFile(
    normalizedPath,
    params.normalizedDraft ??
      "# PRD MCP 未命中（normalized）\n\n本次未获得可归一化的 PRD 草案。",
    "utf-8",
  );
  await writeFile(
    inputPath,
    JSON.stringify(params.finalizeInput, null, 2),
    "utf-8",
  );
  await writeFile(finalPath, params.finalRequirement ?? "", "utf-8");
  return { runId, statusPath, rawPath, normalizedPath, inputPath, finalPath };
}

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve(process.cwd(), "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(message: string): void {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

setBroadcaster((payload) => {
  broadcast(JSON.stringify(payload));
});

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "LOG_ADDED",
      data: {
        logType: "INFO",
        title: "WebSocket 已连接",
        summary: "等待任务启动...",
        timestamp: new Date().toISOString(),
      },
    }),
  );
});

app.get("/api/v1/config", (_req, res) => {
  res.json({
    llm: {
      baseUrl: "https://api.deepseek.com",
      modelName: "deepseek-chat",
    },
    workspace: {
      path: "output",
    },
  });
});

app.post("/api/v1/config/llm/test", async (req, res) => {
  const llm = req.body?.llm ?? {};
  const apiKey = String(llm.apiKey || "").trim();
  const baseUrl = String(llm.baseUrl || "https://api.deepseek.com");
  const modelName = String(llm.modelName || "deepseek-chat");

  if (!apiKey) {
    res.status(400).json({ success: false, message: "API Key is required" });
    return;
  }

  try {
    const model = new ChatOpenAI({
      model: modelName,
      apiKey,
      configuration: { baseURL: baseUrl },
      temperature: 0.1,
      timeout: 10000,
      maxRetries: 0,
    });
    
    // Send a minimal request to test the connection
    await model.invoke([new HumanMessage("hi")]);
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message });
  }
});

app.post("/api/v1/config/workspace/choose", async (_req, res) => {
  try {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.ShowNewFolderButton = $true",
      "$result = $dialog.ShowDialog()",
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ");

    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-STA",
      "-Command",
      script,
    ]);

    const selectedPath = stdout.trim();
    if (!selectedPath) {
      res.status(400).json({ success: false, message: "No folder selected" });
      return;
    }

    res.json({ success: true, path: selectedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message });
  }
});

app.post("/api/v1/elicitation/questionnaire", async (req, res) => {
  const requirement = String(req.body?.requirement ?? "").trim();
  const contextParse = ClarificationContextSchema.safeParse(req.body?.context ?? {});
  const context = contextParse.success ? contextParse.data : {};
  const llm = req.body?.llm ?? {};
  const elicitationMode =
    String(req.body?.elicitationMode ?? "quick").toLowerCase() === "deep"
      ? "deep"
      : "quick";
  const workspacePath = req.body?.workspace?.path ? path.resolve(String(req.body.workspace.path)) : path.resolve(process.cwd());
  const batchSizeRaw = Number(req.body?.batchSize ?? (elicitationMode === "deep" ? 24 : 16));
  const batchSize = Number.isFinite(batchSizeRaw) ? Math.max(5, Math.min(30, Math.floor(batchSizeRaw))) : 16;
  const targetTotalRaw = Number(req.body?.targetTotal ?? 100);
  const targetTotal = Number.isFinite(targetTotalRaw) ? Math.max(1, Math.min(100, Math.floor(targetTotalRaw))) : 100;
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

  try {
    const startedAt = Date.now();
    const mcpClient = await JapMcpClient.getSharedClient(workspacePath);
    const contextStartedAt = Date.now();
    const projectContextStr = await mcpClient.readProjectContext(workspacePath);
    const skillContext = await loadSkillContext(workspacePath);
    const contextCostMs = Date.now() - contextStartedAt;
    let finalProjectContext = `${projectContextStr}\n${skillContext}`.trim();
    let deepThinkingCostMs = 0;
    if (elicitationMode === "deep") {
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
        const initialResponse = await thinkModel.invoke([
          new SystemMessage("你是一个需求分析师。遇到复杂问题时，你应该调用 sequentialthinking 工具来梳理逻辑，然后再做决定。"),
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
        ]);
        if (initialResponse.tool_calls && initialResponse.tool_calls.length > 0) {
          const tc = initialResponse.tool_calls[0];
          if (tc && tc.name === "sequentialthinking") {
            const toolResult = await seqThinking.client.callTool({
              name: "sequentialthinking",
              arguments: tc.args,
            });
            finalProjectContext += `\n--- 思考过程 ---\n${JSON.stringify(toolResult, null, 2)}`;
          }
        }
        deepThinkingCostMs = Date.now() - thinkingStartedAt;
      }
    }

    const model = new ChatOpenAI({
      model: modelName,
      apiKey,
      configuration: { baseURL: baseUrl },
      temperature: 0.1,
      timeout: FAST_ELICITATION_TIMEOUT_MS,
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
        .map((q) => buildQuestionSignature(q))
        .slice(-300),
      batchSize,
      targetTotal,
      instruction:
        elicitationMode === "deep"
          ? "请结合 projectContext 和思考过程，基于已有问题补充下一批问题。严格只输出本批 batchSize 条，禁止重复，优先覆盖未充分约束的维度。"
          : "请基于原始需求和 projectContext 快速输出下一批问题。严格只输出本批 batchSize 条，禁止重复，优先高信息密度。",
    };

    const structuredStartedAt = Date.now();
    const result = await structured.invoke([
      new SystemMessage(ELICITATION_PROMPT),
      new HumanMessage(JSON.stringify(payload, null, 2)),
    ]);
    const existingSignatures = new Set<string>(
      ((context.previousRounds ?? [])
        .flatMap((round) => round.questions ?? [])
        .map((q) => buildQuestionSignature(q))) as string[],
    );
    const deduped = dedupeQuestions(
      (result.questionnaire?.questions ?? []) as ClarificationQuestion[],
      existingSignatures,
      batchSize,
    );
    const normalizedResult = {
      ...result,
      questionnaire: {
        questions: deduped.questions,
      },
    };
    const structuredCostMs = Date.now() - structuredStartedAt;
    const totalCostMs = Date.now() - startedAt;
    res.json({
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
          returned: normalizedResult.questionnaire?.questions?.length ?? 0,
          droppedAsDuplicate: deduped.dropped,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.json({
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
});

app.post("/api/v1/elicitation/finalize", async (req, res) => {
  const requirement = String(req.body?.requirement ?? "").trim();
  let questionnaire = req.body?.questionnaire ?? { questions: [] };
  if (Array.isArray(questionnaire)) {
    questionnaire = { questions: questionnaire };
  }
  const answers = req.body?.answers ?? {};
  const llm = req.body?.llm ?? {};
  const workspacePath = req.body?.workspace?.path ? path.resolve(String(req.body.workspace.path)) : path.resolve(process.cwd());
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
    let draftFiles:
      | {
          runId: string;
          statusPath: string;
          rawPath: string;
          normalizedPath: string;
          inputPath: string;
          finalPath: string;
        }
      | null = null;
    try {
      const mcpClient = await JapMcpClient.getSharedClient(workspacePath);
      projectContextStr = await mcpClient.readProjectContext(workspacePath);
      availableTools = await mcpClient.listAvailableTools();
      const prdCandidates = mcpClient.getPrdToolCandidates();
      prdMcpAvailable = prdCandidates.some((name) => availableTools.includes(name));
      const topQuestions = Array.isArray((questionnaire as any)?.questions)
        ? ((questionnaire as any).questions as Array<{
            questionText?: string;
            dimension?: string;
          }>)
            .slice(0, 40)
            .map((q) => `${q.dimension ?? ""}:${q.questionText ?? ""}`)
        : [];
      const topAnswers = Object.entries(answers ?? {})
        .slice(0, 40)
        .map(([k, v]) => `${k}:${stringifyAnswer(v)}`);
      if (prdMcpAvailable) {
        prdMcpAttempted = true;
        const prdDraft = await mcpClient.generatePrdDraft({
          productName: "JAP Final Requirement",
          productDescription: requirement,
          targetAudience: "产品经理、技术负责人、开发团队与测试团队",
          coreFeatures:
            topQuestions.length > 0
              ? topQuestions
              : ["从业务目标与澄清问卷生成完整需求"],
          constraints: ["输出可用于系统建模", "需求边界清晰且可执行"],
          additionalContext: ["Questionnaire answers:", ...topAnswers].join("\n"),
        });
        if (prdDraft?.draft) {
          prdDraftRaw = prdDraft.draft;
          prdDraftNormalized = normalizePrdDraft(prdDraft.draft);
          prdDraftToolName = prdDraft.toolName;
          prdMcpReason = `已通过工具 ${prdDraft.toolName} 生成 PRD 草案`;
        } else {
          prdMcpReason = "PRD MCP 可用但未返回有效草案文本";
        }
      } else {
        prdMcpReason =
          "未检测到 PRD MCP 可用工具（generate_prd/create_prd/build_prd/enhance_prd_content）。可能未安装 prd-creator-mcp 或未成功启动。";
      }
    } catch (mcpError) {
      console.error("Failed to read project context via MCP in finalize:", mcpError);
      prdMcpReason = `MCP 调用异常：${mcpError instanceof Error ? mcpError.message : String(mcpError)}`;
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
      new SystemMessage(FINALIZE_PROMPT),
      new HumanMessage(
        JSON.stringify(
          {
            originalRequirement: requirement,
            questionnaire,
            answers,
            projectContext: `${projectContextStr}\n${skillContext}`.trim(),
            skillContext,
            prdDraft: prdDraftNormalized || "",
            prdDraftToolName: prdDraftToolName || "",
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

app.post("/api/v1/tasks/design-only", async (req, res) => {
  const requirement = String(req.body?.requirement ?? "").trim();
  const llm = req.body?.llm ?? {};
  const workspace = req.body?.workspace ?? {};
  
  let questionnaire = req.body?.questionnaire ?? null;
  if (Array.isArray(questionnaire)) {
    questionnaire = { questions: questionnaire };
  }

  const userAnswers =
    req.body?.userAnswers && typeof req.body.userAnswers === "object"
      ? (req.body.userAnswers as Record<string, string | string[]>)
      : {};

  if (!requirement) {
    res.status(400).json({ message: "requirement is required" });
    return;
  }

  const taskId = randomUUID();
  res.json({ taskId, status: "INTENT_ANALYSIS" });

  setImmediate(async () => {
    beginTask(taskId);
    emitStageChanged("INTENT_ANALYSIS");
    emitLogAdded("INFO", "任务已创建", "开始进入图纸生成流程。");

    const state: JapState = {
      originalRequirement: requirement,
      questionnaire:
        questionnaire &&
        typeof questionnaire === "object" &&
        Array.isArray((questionnaire as any).questions)
          ? (questionnaire as JapState["questionnaire"])
          : null,
      userAnswers,
      artifacts: {},
      errors: [],
      llmConfig: {
        baseUrl: String(llm.baseUrl || "https://api.deepseek.com"),
        apiKey: String(llm.apiKey || ""),
        modelName: String(llm.modelName || "deepseek-chat"),
      },
      workspaceConfig: workspace.path ? { path: String(workspace.path) } : null,
    };

    try {
      const finalState = (await japApp.invoke(state as any, {
        recursionLimit: 25,
      })) as unknown as JapState;

      if (finalState.errors?.length) {
        emitStageChanged("FAILED");
        emitLogAdded(
          "ERROR",
          "任务失败",
          finalState.errors.join(" | ") || "流程执行失败",
        );
        emitTaskFinished("FAILED", {
          errors: finalState.errors,
          artifactCount: Object.keys(finalState.artifacts ?? {}).length,
        });
      } else {
        emitStageChanged("COMPLETED");
        emitLogAdded(
          "SUCCESS",
          "任务完成",
          `已生成 ${Object.keys(finalState.artifacts ?? {}).length} 份交付物。`,
        );
        emitTaskFinished("COMPLETED", {
          artifactCount: Object.keys(finalState.artifacts ?? {}).length,
          artifacts: Object.keys(finalState.artifacts ?? {}),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitStageChanged("FAILED");
      emitLogAdded("ERROR", "任务异常", message);
      emitTaskFinished("FAILED", { errors: [message] });
    } finally {
      endTask();
    }
  });
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`J-AP Plus web server running at http://localhost:${port}`);
});
