import type { Request, Response } from "express";
import { WebSocketServer } from "ws";
import path from "node:path";
import {
  ElicitationService,
  ClarificationContextSchema,
  type ClarificationContext,
  normalizeQuestionnaireInput,
  buildFallbackQuestionnaire,
} from "../services/elicitationService.js";
import { clampInteger } from "../utils/stringUtils.js";
import { isRecord } from "../utils/typeUtils.js";

function wssBroadcastElicitationResult(wss: WebSocketServer, result: any) {
  const msg = JSON.stringify({ type: "elicitation-result", payload: result });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

export class ElicitationController {
  private service: ElicitationService;
  private wss: WebSocketServer;

  constructor(wss: WebSocketServer) {
    this.service = new ElicitationService();
    this.wss = wss;
  }

  async questionnaire(req: Request, res: Response) {
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
        const result = await this.service.processElicitation({
          requirement,
          context,
          elicitationMode,
          workspacePath,
          batchSize,
          targetTotal,
          apiKey,
          baseUrl,
          modelName,
        });
        wssBroadcastElicitationResult(this.wss, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        wssBroadcastElicitationResult(this.wss, {
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
  }

  async finalize(req: Request, res: Response) {
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
      const result = await this.service.processFinalize({
        requirement,
        questionnaire,
        answers,
        workspacePath,
        apiKey,
        baseUrl,
        modelName,
        persistDraft,
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message });
    }
  }
}
