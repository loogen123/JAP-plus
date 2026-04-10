import cors from "cors";
import express from "express";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

import { japApp } from "./workflow/japGraph.js";
import {
  beginTask,
  emitLogAdded,
  emitStageChanged,
  emitTaskFinished,
  endTask,
  setBroadcaster,
} from "./runtime/workflowEvents.js";
import { QuestionnaireSchema, type JapState } from "./state/japState.js";

const execFileAsync = promisify(execFile);
const ELICITATION_PROMPT = `
你是 J-AP Plus 的需求澄清助手。
请根据用户业务目标生成 5-8 个高质量单选题，覆盖：
- 核心实体
- 状态边界
- 安全权限
- 外部依赖

硬约束：
- 仅返回结构化结果，不要解释性文本
- 每题 options 为 3-5 个互斥选项
`.trim();

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

app.post("/api/v1/config/llm/test", (_req, res) => {
  res.json({ success: true });
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
  const llm = req.body?.llm ?? {};
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
    const model = new ChatOpenAI({
      model: modelName,
      apiKey,
      configuration: { baseURL: baseUrl },
      temperature: 0.2,
      timeout: 20000,
      maxRetries: 0,
    });

    const structured = model.withStructuredOutput(QuestionnaireSchema);
    const questionnaire = await structured.invoke([
      new SystemMessage(ELICITATION_PROMPT),
      new HumanMessage(requirement),
    ]);

    res.json({ questionnaire });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message });
  }
});

app.post("/api/v1/tasks/design-only", async (req, res) => {
  const requirement = String(req.body?.requirement ?? "").trim();
  const llm = req.body?.llm ?? {};
  const workspace = req.body?.workspace ?? {};
  const userAnswers =
    req.body?.userAnswers && typeof req.body.userAnswers === "object"
      ? (req.body.userAnswers as Record<string, string>)
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
      questionnaire: null,
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
