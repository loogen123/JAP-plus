export function openSettingsAction(ctx) {
  document.getElementById("testConnResult").style.display = "none";
  document.getElementById("elicitationMode").value = ctx.getElicitationMode();
  const showEl = document.getElementById("showIntermediateArtifacts");
  if (showEl) showEl.checked = ctx.getShowIntermediateArtifacts();
  const settingsModal = document.getElementById("settingsModal");
  const historyModal = document.getElementById("historyModal");
  if (historyModal?.classList.contains("show")) {
    settingsModal.style.zIndex = "90";
  } else {
    settingsModal.style.zIndex = "";
  }
  settingsModal.classList.add("show");
}

export function closeSettingsAction() {
  const settingsModal = document.getElementById("settingsModal");
  settingsModal.classList.remove("show");
  settingsModal.style.zIndex = "";
}

export function buildTaskLlmConfigAction(ctx) {
  const baseUrl = (document.getElementById("llmBaseUrl").value || "").trim();
  const apiKey = (document.getElementById("llmApiKey").value || "").trim();
  const modelName = (document.getElementById("llmModelName").value || "").trim();
  const cached = ctx.getSessionLlmConfig();
  const cfg = {
    baseUrl: baseUrl || cached?.baseUrl || "https://api.deepseek.com",
    apiKey: apiKey || cached?.apiKey || "",
    modelName: modelName || cached?.modelName || "deepseek-chat",
  };
  if (!cfg.apiKey) {
    ctx.updateLlmChip(false);
    return null;
  }
  ctx.setSessionLlmConfig(cfg);
  ctx.updateLlmChip(true);
  return cfg;
}

export function validateWorkspaceAction(ctx) {
  const p = (document.getElementById("workspacePath").value || "").trim();
  if (!p) {
    document.getElementById("workspaceStatus").textContent = "未设置";
    document.getElementById("workspacePathLabel").textContent = "output";
    ctx.setWorkspacePathConfig("");
    return;
  }
  document.getElementById("workspaceStatus").textContent = `当前目录：${p}`;
  document.getElementById("workspacePathLabel").textContent = p;
  ctx.setWorkspacePathConfig(p);
}

export function saveSettingsAction(ctx) {
  const llm = ctx.buildTaskLlmConfig();
  if (!llm) {
    ctx.addLog("错误", "保存失败：API Key 不能为空", "error");
    return;
  }
  const mode = (document.getElementById("elicitationMode").value || "quick").trim();
  ctx.setElicitationMode(mode);
  const showIntermediate = Boolean(document.getElementById("showIntermediateArtifacts")?.checked);
  ctx.setShowIntermediateArtifacts(showIntermediate);
  ctx.updateLlmChip(true);
  ctx.validateWorkspace();
  ctx.closeSettings();
  if (ctx.currentRunState()?.files) ctx.updateFileTree(ctx.currentRunState().files);
  ctx.addLog("系统", `设置已保存（澄清模式：${mode === "deep" ? "深度" : "快速"}）`, "success");
}

export async function chooseWorkspaceFolderAction(ctx) {
  try {
    const resp = await fetch(ctx.apiBase + "/api/v1/config/workspace/choose", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || !data?.path) {
      ctx.addLog("错误", data?.message || "未选择目录", "error");
      return;
    }
    document.getElementById("workspacePath").value = data.path;
    ctx.validateWorkspace();
    ctx.addLog("系统", `已选择输出目录：${data.path}`, "success");
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}

export async function testLlmConnectionAction(ctx) {
  const llm = ctx.buildTaskLlmConfig();
  const resultDiv = document.getElementById("testConnResult");
  resultDiv.style.display = "block";
  if (!llm) {
    resultDiv.style.color = "var(--red)";
    resultDiv.textContent = "❌ 请先输入 API Key";
    ctx.addLog("错误", "请先输入 API Key", "error");
    return;
  }
  resultDiv.style.color = "var(--muted)";
  resultDiv.textContent = "⏳ 正在测试连接中...";
  try {
    const resp = await fetch(ctx.apiBase + "/api/v1/config/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm }),
    });
    if (resp.ok) {
      resultDiv.style.color = "var(--green)";
      resultDiv.textContent = "✅ LLM 连接测试成功";
      ctx.addLog("系统", "LLM 连接测试成功", "success");
      return;
    }
    const errData = await resp.json().catch(() => ({}));
    resultDiv.style.color = "var(--red)";
    resultDiv.textContent = "❌ LLM 连接测试失败: " + (errData.message || resp.statusText || resp.status);
    ctx.addLog("系统", "LLM 连接测试失败: " + (errData.message || resp.statusText || resp.status), "error");
  } catch (e) {
    resultDiv.style.color = "var(--red)";
    resultDiv.textContent = "❌ LLM 连接测试异常: " + (e.message || String(e));
    ctx.addLog("错误", "LLM 连接测试异常: " + (e.message || String(e)), "error");
  }
}

export async function loadSettingsAction(ctx) {
  try {
    const resp = await fetch(ctx.apiBase + "/api/v1/config");
    if (resp.ok) {
      const conf = await resp.json();
      document.getElementById("llmBaseUrl").value = conf?.llm?.baseUrl || "https://api.deepseek.com";
      document.getElementById("llmModelName").value = conf?.llm?.modelName || "deepseek-chat";
      document.getElementById("workspacePath").value = conf?.workspace?.path || "output";
    }
  } catch {}
  const llm = ctx.getSessionLlmConfig();
  if (llm) {
    document.getElementById("llmBaseUrl").value = llm.baseUrl || "";
    document.getElementById("llmApiKey").value = llm.apiKey || "";
    document.getElementById("llmModelName").value = llm.modelName || "";
  }
  document.getElementById("elicitationMode").value = ctx.getElicitationMode();
  ctx.updateLlmChip(Boolean(llm && llm.apiKey));
  const w = ctx.getWorkspacePathConfig();
  if (w?.path) {
    document.getElementById("workspacePath").value = w.path;
  }
  ctx.validateWorkspace();
  ctx.refreshDesignButtonState();
}
