import type { Express } from "express";
import { WebSocketServer } from "ws";
import { ElicitationController } from "../controllers/elicitationController.js";

export function registerElicitationRoutes(app: Express, wss: WebSocketServer): void {
  const controller = new ElicitationController(wss);

  app.post("/api/v1/elicitation/questionnaire", (req, res) => {
    controller.questionnaire(req, res);
  });

  app.post("/api/v1/elicitation/finalize", (req, res) => {
    controller.finalize(req, res);
  });
}
