import fs from "node:fs/promises";
import path from "node:path";

import { END, START, StateGraph } from "@langchain/langgraph";

import { WORKFLOW_LOG_TEXT } from "../constants/logTexts.js";
import { detailingNode } from "../nodes/detailingNode.js";
import { generateQuestionnaire } from "../nodes/elicitationNode.js";
import { modelingNode } from "../nodes/modelingNode.js";
import { reviewNode } from "../nodes/reviewNode.js";
import { emitLogAdded, emitStageChanged } from "../runtime/workflowEvents.js";
import type { JapState } from "../state/japState.js";
import { JapMcpClient } from "../tools/mcpClient.js";

const replaceValue = <T>(_left: T, right: T): T => right;

async function presentationNode(state: JapState): Promise<Partial<JapState>> {
  emitStageChanged("DELIVERY_RELEASE");
  emitLogAdded("INFO", WORKFLOW_LOG_TEXT.presentStartTitle, WORKFLOW_LOG_TEXT.presentStartSummary);

  const projectRoot = path.resolve(process.cwd());
  const outputDir = state.workspaceConfig?.path
    ? path.resolve(state.workspaceConfig.path)
    : path.resolve(projectRoot, "output");
  const mcpClient = new JapMcpClient();

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await mcpClient.connect(projectRoot);
    await mcpClient.writeArtifactsToDisk(state.artifacts, outputDir);
    emitLogAdded("SUCCESS", WORKFLOW_LOG_TEXT.presentDoneTitle, WORKFLOW_LOG_TEXT.presentDoneSummary);
    return { errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitLogAdded("ERROR", WORKFLOW_LOG_TEXT.presentErrorTitle, message);
    return {
      errors: [...state.errors, `Presentation node failed: ${message}`],
    };
  } finally {
    await mcpClient.close();
  }
}

const workflow = new StateGraph<JapState>({
  channels: {
    originalRequirement: {
      reducer: replaceValue<string>,
      default: () => "",
    },
    questionnaire: {
      reducer: replaceValue<JapState["questionnaire"]>,
      default: () => null,
    },
    userAnswers: {
      reducer: replaceValue<Record<string, string | string[]>>,
      default: () => ({}),
    },
    artifacts: {
      reducer: replaceValue<Record<string, string>>,
      default: () => ({}),
    },
    errors: {
      reducer: replaceValue<string[]>,
      default: () => [],
    },
    llmConfig: {
      reducer: replaceValue<JapState["llmConfig"]>,
      default: () => null,
    },
    workspaceConfig: {
      reducer: replaceValue<JapState["workspaceConfig"]>,
      default: () => null,
    },
  },
})
  .addNode("elicitation", generateQuestionnaire)
  .addNode("modelingNode", modelingNode)
  .addNode("reviewNode", reviewNode)
  .addNode("detailingNode", detailingNode)
  .addNode("presentationNode", presentationNode)
  .addEdge(START, "elicitation")
  .addEdge("elicitation", "modelingNode")
  .addEdge("modelingNode", "reviewNode")
  .addConditionalEdges("reviewNode", (state: JapState) =>
    state.errors.length > 0 ? "modelingNode" : "detailingNode",
  )
  .addEdge("detailingNode", "presentationNode")
  .addEdge("presentationNode", END);

export const japApp = workflow.compile();
