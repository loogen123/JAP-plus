import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { Express } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function registerConfigRoutes(app: Express): void {
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
}
