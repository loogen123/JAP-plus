import { resetDagUI } from "./dagRenderer.js";

export function createModuleSelectionController() {
  let resolveModuleSelection = null;
  function promptForModules() {
    return new Promise((resolve) => {
      document.getElementById("moduleSelectionModal").classList.add("show");
      resolveModuleSelection = resolve;
    });
  }
  function confirmModuleSelection() {
    const selected = [];
    if (document.getElementById("mod02").checked) selected.push("02");
    if (document.getElementById("mod03").checked) selected.push("03");
    if (document.getElementById("mod04").checked) selected.push("04");
    if (document.getElementById("mod05").checked) selected.push("05");
    if (document.getElementById("mod06").checked) selected.push("06");
    document.getElementById("moduleSelectionModal").classList.remove("show");
    if (resolveModuleSelection) {
      resolveModuleSelection(selected);
      resolveModuleSelection = null;
    }
  }
  return { promptForModules, confirmModuleSelection };
}

export async function toggleAutoRunAction(ctx) {
  if (ctx.isAutoRunning()) {
    ctx.setAutoRunning(false);
    ctx.addLog("系统", "已停止自动生成");
    ctx.renderWorkflowButtons();
    return;
  }
  if (!ctx.currentRunId()) {
    ctx.addLog("系统", "当前没有正在运行的任务");
    return;
  }
  if (!ctx.currentRunState()?.selectedModules) {
    const selectedModules = await ctx.promptForModules();
    try {
      const workspacePath = (document.getElementById("workspacePath").value || "").trim();
      const patchResp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/modules`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedModules,
          workspace: workspacePath ? { path: workspacePath } : undefined,
        }),
      });
      if (!patchResp.ok) {
        ctx.addLog("错误", "配置架构模块失败", "error");
        return;
      }
      ctx.patchCurrentRunState({ selectedModules });
    } catch {
      ctx.addLog("错误", "配置架构模块网络异常", "error");
      return;
    }
  }
  ctx.setAutoRunning(true);
  ctx.addLog("系统", "已开启一键自动并发生成，将自动跑完前置基础设计文件...");
  ctx.renderWorkflowButtons();
  ctx.autoRunLoop();
}

export async function autoRunLoopAction(ctx) {
  while (ctx.isAutoRunning() && ctx.currentRunId() && ctx.currentRunState()) {
    const actions = ctx.currentRunState()?.actions || {};
    if (ctx.currentRunState()?.stage === "DONE" || !ctx.currentRunState()?.currentFile) {
      ctx.addLog("系统", "自动生成已完成", "success");
      await ctx.toggleAutoRun();
      break;
    }
    try {
      if (actions.canGenerateNext) {
        await ctx.filewiseGenerateNext();
      } else if (actions.canApprove) {
        ctx.closeFileReviewModal();
        await ctx.filewiseApprove();
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch {
      ctx.addLog("错误", "自动生成遇到错误，已暂停", "error");
      await ctx.toggleAutoRun();
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function filewiseGenerateBaseNextAction(ctx) {
  if (!ctx.currentRunId()) {
    ctx.addLog("系统", "当前不是 filewise 任务");
    return;
  }
  const llm = ctx.buildTaskLlmConfig();
  if (!llm) {
    ctx.addLog("错误", "请先在设置中配置 API Key", "error");
    ctx.openSettings();
    return;
  }
  ctx.setGeneratingBase(true);
  ctx.renderWorkflowButtons();
  try {
    const workspacePath = (document.getElementById("workspacePath").value || "").trim();
    const resp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/generate-base-next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm,
        workspace: workspacePath ? { path: workspacePath } : undefined,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const fileId = data?.currentFile;
      const detail = Array.isArray(data?.files) && fileId ? (data.files.find((f) => f.fileId === fileId)?.lastError || "") : "";
      ctx.addLog("错误", [data?.message || "生成失败", detail].filter(Boolean).join(" | "), "error");
      return;
    }
    ctx.setCurrentRunState(data);
    await ctx.refreshFilewiseRun();
  } finally {
    ctx.setGeneratingBase(false);
    ctx.renderWorkflowButtons();
  }
}

export async function filewiseGenerateTasksAction(ctx, sourceRunId) {
  if (!ctx.currentRunId()) {
    ctx.addLog("系统", "当前不是 filewise 任务");
    return;
  }
  const llm = ctx.buildTaskLlmConfig();
  if (!llm) {
    ctx.addLog("错误", "请先在设置中配置 API Key", "error");
    ctx.openSettings();
    return;
  }
  ctx.setGeneratingSdd(true);
  ctx.renderWorkflowButtons();
  ctx.startSddHeartbeat();
  const workspacePath = (document.getElementById("workspacePath").value || "").trim();
  ctx.addLog("系统", "正在生成开发任务清单(Tasks)...");
  try {
    const resp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/generate-sdd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm,
        sourceRunId: sourceRunId || undefined,
        workspace: workspacePath ? { path: workspacePath } : undefined,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      ctx.addLog("错误", ctx.buildSddErrorMessage(data), "error");
      await ctx.pullRecentEvents(200);
      ctx.stopSddHeartbeat();
      return;
    }
    if (data?.runId) {
      if (data.runId !== ctx.currentRunId()) {
        ctx.setRecentEventState({ lastAt: "", cursor: 0 });
      }
      ctx.setCurrentRunId(data.runId);
      ctx.setCurrentTaskId(data.runId);
      ctx.setTaskIdentity(data.runId, sourceRunId || document.getElementById("sourceTaskId").textContent || "--");
      ctx.connectWebSocketForTask(data.runId);
    }
    ctx.setCurrentRunState(data);
    await ctx.refreshFilewiseRun();
  } catch (err) {
    ctx.addLog("错误", "生成任务清单请求异常: " + String(err?.message || err), "error");
    ctx.stopSddHeartbeat();
  } finally {
    ctx.setGeneratingSdd(false);
    ctx.renderWorkflowButtons();
  }
}

export async function filewiseGenerateNextAction(ctx) {
  resetDagUI();
  const dagContainer = document.getElementById("executionDagContainer");
  if (dagContainer) {
    dagContainer.style.display = "block";
  }
  if (ctx.currentRunState()?.currentFile === "07") {
    await ctx.filewiseGenerateTasks();
    return;
  }
  await ctx.filewiseGenerateBaseNext();
}

export async function filewiseApproveAction(ctx) {
  if (!ctx.currentRunId() || !ctx.currentRunState()?.currentFile) return;
  const workspacePath = (document.getElementById("workspacePath").value || "").trim();
  const fileId = ctx.currentRunState().currentFile;
  if (fileId === "01" && !ctx.currentRunState()?.selectedModules) {
    const selectedModules = await ctx.promptForModules();
    try {
      const patchResp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/modules`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedModules,
          workspace: workspacePath ? { path: workspacePath } : undefined,
        }),
      });
      if (!patchResp.ok) {
        const errData = await patchResp.json();
        ctx.addLog("错误", errData?.message || "配置架构模块失败", "error");
        return;
      }
      ctx.patchCurrentRunState({ selectedModules });
    } catch {
      ctx.addLog("错误", "配置架构模块网络异常", "error");
      return;
    }
  }
  const resp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/files/${encodeURIComponent(fileId)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: workspacePath ? { path: workspacePath } : undefined }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    ctx.addLog("错误", data?.message || "通过失败", "error");
    return;
  }
  ctx.setCurrentRunState(data);
  await ctx.refreshFilewiseRun();
}

export async function filewiseRejectAction(ctx) {
  if (!ctx.currentRunId() || !ctx.currentRunState()?.currentFile) return;
  const reason = (document.getElementById("fileRejectReason").value || "").trim();
  const workspacePath = (document.getElementById("workspacePath").value || "").trim();
  const fileId = ctx.currentRunState().currentFile;
  const resp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/files/${encodeURIComponent(fileId)}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason, workspace: workspacePath ? { path: workspacePath } : undefined }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    ctx.addLog("错误", data?.message || "驳回失败", "error");
    return;
  }
  ctx.setCurrentRunState(data);
  await ctx.refreshFilewiseRun();
}

export async function filewiseRegenerateAction(ctx) {
  if (!ctx.currentRunId() || !ctx.currentRunState()?.currentFile) return;
  const llm = ctx.buildTaskLlmConfig();
  if (!llm) {
    ctx.addLog("错误", "请先在设置中配置 API Key", "error");
    ctx.openSettings();
    return;
  }
  const workspacePath = (document.getElementById("workspacePath").value || "").trim();
  const fileId = ctx.currentRunState().currentFile;
  const resp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/files/${encodeURIComponent(fileId)}/regenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      llm,
      workspace: workspacePath ? { path: workspacePath } : undefined,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const failedFileId = data?.currentFile;
    const detail = Array.isArray(data?.files) && failedFileId ? (data.files.find((f) => f.fileId === failedFileId)?.lastError || "") : "";
    ctx.addLog("错误", [data?.message || "重生成失败", detail].filter(Boolean).join(" | "), "error");
    return;
  }
  ctx.setCurrentRunState(data);
  await ctx.refreshFilewiseRun();
}

export async function filewiseSaveEditAction(ctx) {
  if (!ctx.currentRunId() || !ctx.currentRunState()?.currentFile) return;
  const content = document.getElementById("filePreview").value || "";
  if (!content.trim()) {
    ctx.addLog("错误", "当前编辑区为空，先生成文件或输入内容后再保存", "error");
    ctx.updateFileActionButtons();
    return;
  }
  const workspacePath = (document.getElementById("workspacePath").value || "").trim();
  const fileId = ctx.currentRunState().currentFile;
  const resp = await fetch(ctx.apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(ctx.currentRunId())}/files/${encodeURIComponent(fileId)}/save-edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, workspace: workspacePath ? { path: workspacePath } : undefined }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    ctx.addLog("错误", data?.message || "保存失败", "error");
    return;
  }
  ctx.setCurrentRunState(data);
  ctx.addLog("系统", `文件 ${fileId} 修改已保存`, "success");
  ctx.setFilePreviewDirty(false);
  await ctx.refreshFilewiseRun();
}
