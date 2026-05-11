export function getActiveWorkspacePathAction(ctx) {
  const p = (document.getElementById("workspacePath").value || "").trim();
  if (p) return p;
  return ctx.getWorkspacePathConfig()?.path || "output";
}

export function getHistoryWorkspacePathAction(ctx) {
  const modalPath = (document.getElementById("historyWorkspacePath").value || "").trim();
  if (modalPath) return modalPath;
  return getActiveWorkspacePathAction(ctx);
}

export function getTasksSourceWorkspacePathAction(ctx) {
  const modalPath = (document.getElementById("tasksSourceWorkspacePath").value || "").trim();
  if (modalPath) return modalPath;
  return getActiveWorkspacePathAction(ctx);
}

export async function chooseHistoryWorkspaceFolderAction(ctx) {
  try {
    const resp = await fetch(ctx.apiBase + "/api/v1/config/workspace/choose", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || !data?.path) {
      ctx.addLog("错误", data?.message || "未选择目录", "error");
      return;
    }
    document.getElementById("historyWorkspacePath").value = data.path;
    await ctx.loadHistoryList();
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}

export function openHistoryModalAction(ctx) {
  const currentPath = getActiveWorkspacePathAction(ctx);
  if (currentPath) {
    document.getElementById("historyWorkspacePath").value = currentPath;
  }
  document.getElementById("historyModal").classList.add("show");
  void ctx.loadHistoryList();
}

export function closeHistoryModalAction() {
  document.getElementById("historyModal").classList.remove("show");
}

export async function chooseTasksSourceWorkspaceFolderAction(ctx) {
  try {
    const resp = await fetch(ctx.apiBase + "/api/v1/config/workspace/choose", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || !data?.path) {
      ctx.addLog("错误", data?.message || "未选择目录", "error");
      return;
    }
    document.getElementById("tasksSourceWorkspacePath").value = data.path;
    await ctx.loadTasksSourceRuns();
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}

export function openTasksSourceModalAction(ctx) {
  const currentPath = getActiveWorkspacePathAction(ctx);
  if (currentPath) {
    document.getElementById("tasksSourceWorkspacePath").value = currentPath;
  }
  ctx.setSelectedTasksSourceRunId(null);
  document.getElementById("tasksSourceModal").classList.add("show");
  void ctx.loadTasksSourceRuns();
}

export function closeTasksSourceModalAction() {
  document.getElementById("tasksSourceModal").classList.remove("show");
}

export function renderTasksSourceRunsAction(ctx) {
  ctx.renderTasksSourceRunsView({
    tasksSourceRuns: ctx.tasksSourceRuns(),
    selectedTasksSourceRunId: ctx.selectedTasksSourceRunId(),
    onSelectRun: (runId) => {
      ctx.setSelectedTasksSourceRunId(runId);
      ctx.renderTasksSourceRuns();
    },
  });
}

export async function loadTasksSourceRunsAction(ctx) {
  const workspacePath = getTasksSourceWorkspacePathAction(ctx);
  try {
    const { ok, data } = await ctx.fetchTasksSourceRuns(ctx.apiBase, workspacePath);
    if (!ok) {
      ctx.addLog("错误", data?.message || "加载SDD历史流程失败", "error");
      return;
    }
    ctx.setTasksSourceRuns(Array.isArray(data?.items) ? data.items : []);
    ctx.renderTasksSourceRuns();
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}

export function renderHistoryListAction(ctx) {
  ctx.renderHistoryListView({
    historyRecords: ctx.historyRecords(),
    selectedHistory: ctx.selectedHistory(),
    onSelectHistory: (id, type) => {
      void ctx.selectHistory(id, type);
    },
  });
}

export function renderHistoryTabsAction(ctx) {
  ctx.renderHistoryTabsView({
    selectedHistoryPreviewKey: ctx.selectedHistoryPreviewKey(),
    onSwitchTab: (key) => {
      ctx.setSelectedHistoryPreviewKey(key);
      ctx.renderHistoryTabs();
      ctx.renderHistoryPreview();
    },
  });
}

export function renderHistoryPreviewAction(ctx) {
  ctx.renderHistoryPreviewView({
    selectedHistoryDetail: ctx.selectedHistoryDetail(),
    selectedHistoryPreviewKey: ctx.selectedHistoryPreviewKey(),
    historyWorkspacePath: getHistoryWorkspacePathAction(ctx) || "--",
  });
}

export async function loadHistoryListAction(ctx) {
  const workspacePath = getHistoryWorkspacePathAction(ctx);
  try {
    const { ok, data } = await ctx.fetchHistoryRequirements(ctx.apiBase, workspacePath);
    if (!ok) {
      ctx.setHistoryRecords([]);
      ctx.setSelectedHistory(null);
      ctx.setSelectedHistoryDetail(null);
      ctx.renderHistoryList();
      ctx.renderHistoryTabs();
      ctx.renderHistoryPreview();
      ctx.addLog("错误", data?.message || "读取历史任务失败", "error");
      return;
    }
    if (data?.workspacePath) {
      document.getElementById("historyWorkspacePath").value = data.workspacePath;
    }
    ctx.setHistoryRecords(Array.isArray(data?.items) ? data.items.filter((item) => item?.requirementAvailable) : []);
    ctx.setSelectedHistory(null);
    ctx.setSelectedHistoryDetail(null);
    ctx.setSelectedHistoryPreviewKey("final");
    ctx.renderHistoryList();
    ctx.renderHistoryTabs();
    ctx.renderHistoryPreview();
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}

export async function selectHistoryAction(ctx, id, type) {
  ctx.setSelectedHistory({ id, type });
  ctx.renderHistoryList();
  const workspacePath = getHistoryWorkspacePathAction(ctx);
  try {
    const { ok, data } = await ctx.fetchHistoryRequirementById(ctx.apiBase, id, type, workspacePath);
    if (!ok) {
      ctx.addLog("错误", data?.message || "读取历史详情失败", "error");
      return;
    }
    ctx.setSelectedHistoryDetail(data);
    ctx.setSelectedHistoryPreviewKey(data?.requirement?.source || "final");
    ctx.renderHistoryTabs();
    ctx.renderHistoryPreview();
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}
