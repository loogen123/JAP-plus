import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { ARTIFACT_FILES } from "../constants/domainConstants.js";
import {
  DETAILING_NODE_SYSTEM_PROMPT,
  MODELING_NODE_SYSTEM_PROMPT,
  TASKS_NODE_SYSTEM_PROMPT,
} from "../constants/promptTexts.js";
import { emitTaskScopedEvent } from "../runtime/workflowEvents.js";
import { loadSkillContext } from "../runtime/skillContext.js";
import { appendRunEvent, log } from "../utils/logger.js";
import {
  type ArtifactFileId,
  type FileId,
  type FileRunMeta,
} from "./stateMachine.js";
import { clampText, splitRequirementBySections } from "../utils/stringUtils.js";
import { JapMcpClient } from "../tools/mcpClient.js";
import {
  loadApprovedArtifactSummary,
  readFileBody,
} from "../persistence/artifactStore.js";

const MODELING_FILE_IDS: ArtifactFileId[] = ["01", "02", "03", "04"];
const FILEWISE_CONTEXT_LIMIT = 10000;
const FILEWISE_OUTPUT_LIMIT = 16000;

const FILE_TO_ARTIFACT_KEY: Record<ArtifactFileId, string> = {
  "01": ARTIFACT_FILES.modeling01,
  "02": ARTIFACT_FILES.modeling02,
  "03": ARTIFACT_FILES.modeling03,
  "04": ARTIFACT_FILES.modeling04,
  "05": ARTIFACT_FILES.detailing05,
  "06": ARTIFACT_FILES.detailing06,
  "07": ARTIFACT_FILES.sdd07,
};

async function appendRunLog(meta: FileRunMeta, msg: string): Promise<void> {
  await log(
    { run: meta.runId, file: "07", stage: "DETAILING", level: "info", msg },
    async (type, data) => appendRunEvent(meta.workspacePath, meta.runId, type, data),
  );
}

export async function validateApiConsistency(meta: FileRunMeta, fileId: string, content: string): Promise<void> {
  void meta;
  void fileId;
  void content;
}

function buildQASnapshot(meta: FileRunMeta): string {
  const questions = meta.questionnaire?.questions ?? [];
  return questions
    .slice(0, 30)
    .map((q) => {
      const answer = meta.userAnswers[q.id];
      const answerText = Array.isArray(answer) ? answer.join(" | ") : String(answer ?? "");
      return `Q:${q.questionText}\nA:${answerText || "N/A"}`;
    })
    .join("\n---\n");
}

function createModel(meta: FileRunMeta, timeout: number): ChatOpenAI {
  return new ChatOpenAI({
    model: meta.llm.modelName || "deepseek-chat",
    apiKey: meta.llm.apiKey,
    configuration: { baseURL: meta.llm.baseUrl || "https://api.deepseek.com" },
    temperature: 0.1,
    timeout,
    maxRetries: 0,
  });
}

function buildModelingPrompt(fileId: ArtifactFileId, requirement: string, approvedSummary: string, qa: string, skill: string): string {
  return [
    `Target file: ${FILE_TO_ARTIFACT_KEY[fileId]}`,
    "Requirement:",
    clampText(requirement, FILEWISE_CONTEXT_LIMIT),
    "",
    "Approved file summaries:",
    approvedSummary || "(none)",
    "",
    "Question and answer snapshot:",
    clampText(qa, 3000),
    "",
    "Constraints:",
    "Keep naming consistent with existing artifacts.",
    "Output complete file content for target only.",
    "",
    "Skill context:",
    clampText(skill, 2000),
  ].join("\n");
}

function buildDetailingPrompt(fileId: ArtifactFileId, requirement: string, approvedSummary: string, skill: string): string {
  return [
    `Target file: ${FILE_TO_ARTIFACT_KEY[fileId]}`,
    "Requirement:",
    clampText(requirement, 2800),
    "",
    "Approved base artifact summaries:",
    approvedSummary || "(none)",
    "",
    "Constraints:",
    "Only output content within the target file responsibility.",
    "Do not write implementation details: DB table names, REST paths, component names, or directories.",
    "Do not add requirements outside existing requirement and approved artifacts.",
    "Use concise, actionable, constraint-oriented wording for development agents.",
    "",
    "Skill context:",
    clampText(skill, 1800),
  ].join("\n");
}

function buildSddPrompt(requirement: string, approvedSummary: string, evidence: string, qa: string, skill: string): string {
  return [
    `Target file: ${ARTIFACT_FILES.sdd07}`,
    "Requirement:",
    clampText(requirement, FILEWISE_CONTEXT_LIMIT),
    "",
    "Intermediate artifact summaries (01-07):",
    approvedSummary || "(none)",
    "",
    "Evidence blocks (01-07 content excerpts):",
    evidence || "(none)",
    "",
    "Question and answer snapshot:",
    clampText(qa, 3000),
    "",
    "Constraints:",
    "This file is SDD constraints overview, not implementation tasks.",
    "Only describe file-level scope source, terminology source, and cross-file constraints.",
    "Explicitly state which files cannot introduce new requirements.",
    "Do not include checklist tasks, API path details, DB table definitions, component names, or directory structures.",
    "Keep naming and terms consistent with existing artifacts.",
    "",
    "Skill context:",
    clampText(skill, 2500),
  ].join("\n");
}

async function loadSddEvidence(meta: FileRunMeta): Promise<string> {
  const maxCharsByFile: Partial<Record<FileId, number>> = {
    "01": 5000,
    "02": 8000,
    "03": 6000,
    "04": 12000,
    "05": 5000,
    "06": 5000,
  };
  const blocks: string[] = [];
  const baseFiles = meta.files.filter((f) => f.fileId !== "07");
  for (const file of baseFiles) {
    const fileId = file.fileId;
    try {
      const raw = await readFileBody(meta.workspacePath, meta.runId, fileId);
      const text = raw.trim();
      if (!text) continue;
      const maxChars = maxCharsByFile[fileId] ?? 2000;
      blocks.push(`--- ${FILE_TO_ARTIFACT_KEY[fileId]} ---\n${clampText(text, maxChars)}\n`);
    } catch {
      continue;
    }
  }
  return blocks.join("\n");
}

export async function generateArtifactByLlm(
  meta: FileRunMeta,
  fileId: ArtifactFileId,
  approvedSummary: string,
  fallbackContextOnly: boolean,
  minimalist: boolean = false,
): Promise<string> {
  const model = createModel(meta, fallbackContextOnly ? 35000 : 45000);
  const skill = await loadSkillContext(meta.workspacePath);
  const qa = buildQASnapshot(meta);
  const requirement = fallbackContextOnly
    ? clampText(meta.requirement, 6000)
    : clampText(meta.requirement, FILEWISE_CONTEXT_LIMIT);
  const sddEvidence = fileId === "07" ? await loadSddEvidence(meta) : "";

  let extraPrompt = "";
  if (minimalist) {
    extraPrompt = "\nMINIMALIST MODE: Output ONLY the core structure, bullet points, and basic outlines. DO NOT include detailed explanations or long texts. Keep it as short as possible while preserving the structure.";
  } else if (fileId === "01") {
    extraPrompt = "\nOnly output: goal, scope, user roles, core scenarios, and explicit out-of-scope items.";
  } else if (fileId === "02") {
    extraPrompt = "\nOnly output domain terms, definitions, field meaning, status words, and business terminology.";
  } else if (fileId === "03") {
    extraPrompt = "\nOnly output behavior rules, state transitions, permission boundaries, and exception handling rules.";
  } else if (fileId === "04") {
    extraPrompt = "\nOnly output capability intents such as create/query/review/export; do not write fixed REST paths.";
  } else if (fileId === "05") {
    extraPrompt = "\nOnly output developer-agent execution order, reading order, free-design area, and mandatory constraints.";
  } else if (fileId === "06") {
    extraPrompt = "\nOnly output acceptance criteria, test observation points, and completion judgment. Do not output test code.";
  }

  const prompt =
    fileId === "07"
      ? buildSddPrompt(requirement, approvedSummary, sddEvidence, qa, skill) + extraPrompt
      : MODELING_FILE_IDS.includes(fileId)
        ? buildModelingPrompt(fileId, requirement, approvedSummary, qa, skill) + extraPrompt
        : buildDetailingPrompt(fileId, requirement, approvedSummary, skill) + extraPrompt;

  const baseSystemPrompt = MODELING_FILE_IDS.includes(fileId)
    ? MODELING_NODE_SYSTEM_PROMPT
    : fileId === "07"
      ? TASKS_NODE_SYSTEM_PROMPT
      : DETAILING_NODE_SYSTEM_PROMPT;

  const response = await model.invoke([
    new SystemMessage(baseSystemPrompt + "\n\nYou are generating a single file. Output ONLY the raw markdown content. DO NOT wrap it in JSON or any code blocks. No explanations, no filler. Ensure cross-file naming consistency."),
    new HumanMessage(prompt),
  ]);

  let content = typeof response.content === "string" ? response.content : "";
  content = content.trim();
  if (content.startsWith("```")) {
    const lines = content.split("\n");
    if (lines.length > 1 && lines[0]?.startsWith("```")) {
      lines.shift();
      if (lines[lines.length - 1]?.startsWith("```")) {
        lines.pop();
      }
      content = lines.join("\n").trim();
    }
  }
  if (!content) {
    throw new Error(`empty output for ${fileId}`);
  }
  return content;
}

export async function tryGenerateWithMcp(
  meta: FileRunMeta,
  fileId: FileId,
  approvedSummary: string,
): Promise<{ content: string; toolName: string } | null> {
  if (process.env.DISABLE_MCP === "true") {
    return null;
  }
  try {
    const client = await JapMcpClient.getSharedClient(meta.workspacePath);
    const result = await client.callTextToolByCandidates(
      [`generate_file_${fileId}`, "generate_design_file", "generate_artifact_file", "generate_artifact"],
      {
        fileId,
        requirement: clampText(meta.requirement, 2800),
        approvedSummary: clampText(approvedSummary, 2000),
      },
    );
    if (!result?.content?.trim()) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

export async function runSingleFileGeneration(meta: FileRunMeta, fileId: FileId, attempt: number): Promise<{
  content: string;
  usedMcp: boolean;
  toolName: string | null;
  fallbackReason: string | null;
}> {
  const approvedSummary = await loadApprovedArtifactSummary(meta);
  const isFallback = attempt >= 2;
  const isMinimalist = attempt === 3;

  if (fileId === "07") {
    await appendRunLog(meta, "正在读取所有已生成的前置设计产�?..");
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在读取所有已生成的前置设计产�?..",
    });
    await appendRunLog(meta, "正在为您生成 SDD 约束总览...");
    emitTaskScopedEvent(meta.runId, "LOG_ADDED", {
      logType: "INFO",
      title: "系统",
      summary: "正在为您生成 SDD 约束总览...",
    });
    const content = await generateArtifactByLlm(meta, "07", approvedSummary, isFallback, isMinimalist);
    return { content, usedMcp: false, toolName: null, fallbackReason: null };
  }

  if (attempt === 1) {
    const mcpResult = await tryGenerateWithMcp(meta, fileId, approvedSummary);
    if (mcpResult) {
      return { content: mcpResult.content, usedMcp: true, toolName: mcpResult.toolName, fallbackReason: null };
    }
  }

  const asArtifact = fileId as ArtifactFileId;
  try {
    const content = await generateArtifactByLlm(meta, asArtifact, approvedSummary, isFallback, isMinimalist);
    return {
      content,
      usedMcp: false,
      toolName: null,
      fallbackReason: isMinimalist ? "switched to minimalist mode" : (isFallback ? "switched to fallback context" : "MCP tool unavailable"),
    };
  } catch (error) {
    const sections = splitRequirementBySections(meta.requirement);
    if (sections.length <= 1) {
      throw error;
    }
    const chunks: string[] = [];
    for (const section of sections) {
      const patchMeta: FileRunMeta = { ...meta, requirement: section };
      const partial = await generateArtifactByLlm(patchMeta, asArtifact, approvedSummary, true, isMinimalist);
      chunks.push(partial);
    }
    return {
      content: clampText(chunks.join("\n\n"), FILEWISE_OUTPUT_LIMIT),
      usedMcp: false,
      toolName: null,
      fallbackReason: "MCP tool unavailable; switched to section merge",
    };
  }
}

