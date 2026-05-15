import type { Express } from "express";
import { RAGController } from "../controllers/ragController.js";

export function registerRagRoutes(app: Express): void {
  const controller = new RAGController();
  app.get("/api/v1/rag/knowledge-bases", (req, res) => { void controller.listKBs(req, res); });
  app.post("/api/v1/rag/knowledge-bases", (req, res) => { void controller.createKB(req, res); });
  app.delete("/api/v1/rag/knowledge-bases/:kbId", (req, res) => { void controller.deleteKB(req, res); });
  app.get("/api/v1/rag/knowledge-bases/:kbId", (req, res) => { void controller.getKB(req, res); });
  app.post("/api/v1/rag/knowledge-bases/:kbId/documents", (req, res) => { void controller.uploadDocs(req, res); });
  app.delete("/api/v1/rag/knowledge-bases/:kbId/documents/:docId", (req, res) => { void controller.deleteDoc(req, res); });
  app.get("/api/v1/rag/knowledge-bases/:kbId/documents/:docId/content", (req, res) => { void controller.getDocContent(req, res); });
  app.post("/api/v1/rag/knowledge-bases/:kbId/query", (req, res) => { void controller.queryKB(req, res); });
}
