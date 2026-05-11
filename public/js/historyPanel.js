function esc(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderTasksSourceRunsView(params) {
  const listEl = document.getElementById("tasksSourceList");
  const infoEl = document.getElementById("tasksSourceInfo");
  const confirmBtn = document.getElementById("tasksSourceConfirmBtn");
  if (!Array.isArray(params.tasksSourceRuns) || params.tasksSourceRuns.length === 0) {
    listEl.innerHTML = '<div class="history-empty">未找到可用历史流程（需01-07全部审核通过）</div>';
    infoEl.textContent = "未选择历史流程";
    confirmBtn.disabled = true;
    return;
  }
  listEl.innerHTML = params.tasksSourceRuns.map((item) => {
    const active = params.selectedTasksSourceRunId === item.runId;
    return `<div class="history-item ${active ? "active" : ""}" data-run-id="${esc(item.runId)}"><div style="font-size:13px;font-weight:600;color:#2f4061;">${esc(item.runId)}</div><div class="history-meta">更新时间：${new Date(item.updatedAt).toLocaleString()} · 阶段：${esc(item.stage || "--")}</div><div class="history-summary">状态：${esc(item.status || "--")} · 当前文件：${esc(item.currentFile || "--")}</div></div>`;
  }).join("");
  listEl.querySelectorAll(".history-item[data-run-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const runId = node.getAttribute("data-run-id");
      if (runId) {
        params.onSelectRun(runId);
      }
    });
  });
  const selected = params.tasksSourceRuns.find((item) => item.runId === params.selectedTasksSourceRunId);
  infoEl.textContent = selected ? `已选择：${selected.runId}` : "未选择历史流程";
  confirmBtn.disabled = !selected;
}

export function renderHistoryListView(params) {
  const container = document.getElementById("historyList");
  if (!Array.isArray(params.historyRecords) || params.historyRecords.length === 0) {
    container.innerHTML = '<div class="history-empty">未找到历史任务</div>';
    return;
  }
  container.innerHTML = params.historyRecords.map((item) => {
    const active = params.selectedHistory && params.selectedHistory.id === item.id && params.selectedHistory.type === item.type;
    const typeText = item.type === "draft" ? "draft" : "task";
    const disabledText = item.requirementAvailable ? "" : " · 缺少需求文件";
    return `<div class="history-item ${active ? "active" : ""}" data-id="${esc(item.id)}" data-type="${esc(item.type)}"><div style="font-size:13px;font-weight:600;color:#2f4061;">${esc(item.id)}</div><div class="history-meta">${typeText} · ${new Date(item.createdAt).toLocaleString()}${disabledText}</div><div class="history-summary">${esc(item.summary || "(无摘要)")}</div></div>`;
  }).join("");
  container.querySelectorAll(".history-item[data-id][data-type]").forEach((node) => {
    node.addEventListener("click", () => {
      const id = node.getAttribute("data-id");
      const type = node.getAttribute("data-type");
      if (id && type) {
        params.onSelectHistory(id, type);
      }
    });
  });
}

export function renderHistoryTabsView(params) {
  const tabs = ["final", "normalized", "raw"];
  document.getElementById("historyTabs").innerHTML = tabs.map((key) => {
    const active = params.selectedHistoryPreviewKey === key ? "active" : "";
    return `<button class="history-tab ${active}" data-key="${key}">${key}</button>`;
  }).join("");
  document.querySelectorAll("#historyTabs .history-tab[data-key]").forEach((node) => {
    node.addEventListener("click", () => {
      const key = node.getAttribute("data-key");
      if (key) {
        params.onSwitchTab(key);
      }
    });
  });
}

export function renderHistoryPreviewView(params) {
  const previewEl = document.getElementById("historyPreview");
  const infoEl = document.getElementById("historySelectionInfo");
  const continueBtn = document.getElementById("historyContinueBtn");
  if (!params.selectedHistoryDetail) {
    previewEl.textContent = "请选择左侧历史任务";
    infoEl.textContent = "未选择历史任务";
    continueBtn.disabled = true;
    return;
  }
  const previews = params.selectedHistoryDetail.previews || {};
  const current = previews[params.selectedHistoryPreviewKey] || {};
  const content = current.exists ? (current.content || "") : "该文件不存在";
  const truncated = current.truncated ? "\n\n[预览已截断]" : "";
  previewEl.textContent = content + truncated;
  const src = params.selectedHistoryDetail.id || "--";
  const req = params.selectedHistoryDetail.requirement || {};
  infoEl.textContent = `来源任务ID: ${src} | 需求源: ${req.source || "--"} | 工作目录: ${params.historyWorkspacePath || "--"}`;
  continueBtn.disabled = !req.available;
}
