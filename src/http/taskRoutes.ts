import type { Express } from "express";
import { WebSocketServer } from "ws";
import { TaskController } from "../controllers/taskController.js";

export function registerTaskRoutes(app: Express, wss: WebSocketServer): void {
  const controller = new TaskController();

  // Phase A: Performance observability middleware
  app.use("/api/v1/", (req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      if (duration > 100) {
        console.log(`[Perf] ${req.method} ${req.originalUrl} - ${duration}ms`);
      }
    });
    next();
  });

  app.get("/api/v1/history/requirements", (req, res) => { controller.getHistoryRequirements(req, res); });
  app.get("/api/v1/history/requirements/:id", (req, res) => { controller.getHistoryRequirementById(req, res); });
  app.post("/api/v1/tasks/filewise/start", (req, res) => { controller.startFilewiseTask(req, res); });
  app.get("/api/v1/tasks/filewise/sdd-sources", (req, res) => { controller.listGlobalSddSources(req, res); });
  app.post("/api/v1/tasks/filewise/generate-sdd-from-source", (req, res) => { controller.generateSddFromSource(req, res); });
  app.get("/api/v1/tasks/filewise/:runId", (req, res) => { controller.getFilewiseTask(req, res); });
  app.get("/api/v1/tasks/filewise/:runId/events", (req, res) => { controller.getFilewiseEvents(req, res); });
  app.get("/api/v1/tasks/filewise/:runId/files/:fileId/content", (req, res) => { controller.getFilewiseFileContent(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/generate-next", (req, res) => { controller.generateNext(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/generate-base-next", (req, res) => { controller.generateBaseNext(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/generate-detailing-batch", (req, res) => { controller.generateDetailingBatch(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/generate-sdd", (req, res) => { controller.generateSdd(req, res); });
  app.get("/api/v1/tasks/filewise/:runId/sdd-sources", (req, res) => { controller.listSddSources(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/approve", (req, res) => { controller.approveFile(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/reject", (req, res) => { controller.rejectFile(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/regenerate", (req, res) => { controller.regenerateFile(req, res); });
  app.post("/api/v1/tasks/filewise/:runId/files/:fileId/save-edit", (req, res) => { controller.saveEdit(req, res); });
}
