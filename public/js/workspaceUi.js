export function createWorkspaceUi(ctx) {
  const {
    runtime,
    addLog,
    stateOrder,
    stateLabelMap,
    updateDagNode,
    renderFileTree,
    updateArtifactActionButtons,
    getShowIntermediateArtifacts,
    getSelectPipelineFile,
    getRefreshFilewiseRun,
    pullRecentEvents,
  } = ctx;

  function updateWorkspaceProgress(stage) {
    const idx = Math.max(0, stateOrder.indexOf(stage));
    const pct = Math.round((idx / (stateOrder.length - 2)) * 100);
    const v = stage === "ERROR" ? 100 : Math.min(100, Math.max(0, pct));
    const pb = document.getElementById("workspaceProgressBar");
    if (pb) pb.style.width = `${v}%`;
    const pt = document.getElementById("workspaceProgressText");
    if (pt) pt.textContent = `${v}%`;
    const ws = document.getElementById("workspaceStage");
    if (ws) ws.textContent = stage;
  }

  function activateState(stateName) {
    const target = stateOrder.includes(stateName) ? stateName : "STANDBY";
    const idx = stateOrder.indexOf(target);
    document.querySelectorAll(".state-node").forEach((node) => {
      const s = node.dataset.state;
      const rect = node.querySelector("rect");
      if (!s || !rect) return;
      const sIdx = stateOrder.indexOf(s);
      const active = s === target;
      const done = sIdx > -1 && sIdx < idx && s !== "ERROR";
      node.classList.toggle("active", active);
      if (target === "ERROR" && s === "ERROR") {
        rect.setAttribute("fill", "#ffecef");
        rect.setAttribute("stroke", "#ef9ca8");
        rect.setAttribute("stroke-width", "2");
      } else if (active) {
        rect.setAttribute("fill", "#ebf3ff");
        rect.setAttribute("stroke", "#6aa6ff");
        rect.setAttribute("stroke-width", "2.6");
      } else if (done) {
        rect.setAttribute("fill", "#ecfbf1");
        rect.setAttribute("stroke", "#79c79a");
        rect.setAttribute("stroke-width", "1.5");
      } else {
        rect.setAttribute("fill", "#fff");
        rect.setAttribute("stroke", "#d7e2f3");
        rect.setAttribute("stroke-width", "1.2");
      }
    });
    document.querySelectorAll(".state-arrow").forEach((arrow) => {
      const from = arrow.dataset.from;
      const to = arrow.dataset.to;
      const f = stateOrder.indexOf(from);
      const t = stateOrder.indexOf(to);
      const activePath = f > -1 && t > -1 && t <= idx && target !== "ERROR";
      const retryPath = target === "SOLUTION_DESIGN" && from === "QUALITY_REVIEW" && to === "SOLUTION_DESIGN";
      arrow.setAttribute("stroke", activePath || retryPath ? "#6aa6ff" : "#9cb0cc");
    });
    const label = stateLabelMap[target] || target;
    document.getElementById("stateStatusText").innerHTML = `当前阶段：<strong>${label}</strong> (${target})`;
    document.getElementById("stateStatusDot").style.background = target === "ERROR" ? "#e56a6a" : target === "DONE" ? "#2fb267" : "#6aa6ff";
    updateWorkspaceProgress(target);
  }

  function renderWorkflowButtons() {
    const actions = runtime.currentRunState?.actions || {};
    const currentFile = runtime.currentRunState?.currentFile || null;
    const busy = runtime.isGeneratingBase || runtime.isGeneratingSdd;
    const canGenerateNext = Boolean(actions.canGenerateNext && currentFile);
    const canStartAuto = Boolean(runtime.currentRunId && runtime.currentRunState && runtime.currentRunState.stage !== "DONE" && currentFile);
    const nextBtn = document.getElementById("btnGenerateNext");
    const autoBtn = document.getElementById("btnAutoRun");
    if (nextBtn) {
      nextBtn.disabled = busy || !canGenerateNext;
      if (busy) nextBtn.innerText = "生成中...";
      else if (currentFile === "01") nextBtn.innerText = "生成需求草案 (01)";
      else if (currentFile === "07") nextBtn.innerText = "生成可执行任务清单 (08)";
      else if (currentFile && currentFile !== "01" && currentFile !== "07") nextBtn.innerText = "并发生成架构设计模块 (02-07)";
      else nextBtn.innerText = "生成下一步工件";
    }
    if (autoBtn) {
      if (runtime.isAutoRunning) {
        autoBtn.textContent = "停止自动流转";
        autoBtn.style.background = "#fff7f7";
        autoBtn.style.color = "#d85555";
        autoBtn.style.borderColor = "#f1c3c3";
        autoBtn.disabled = busy;
      } else {
        autoBtn.textContent = "一键自动流转 (免人工审核)";
        autoBtn.style.background = "#f2f7ff";
        autoBtn.style.color = "#2f5d9e";
        autoBtn.style.borderColor = "#a8c5ff";
        autoBtn.disabled = busy || !canStartAuto;
      }
    }
  }

  function updateFileActionButtons() {
    updateArtifactActionButtons({
      currentRunState: runtime.currentRunState,
      renderWorkflowButtons,
    });
  }

  function updateFileTree(files) {
    const result = renderFileTree({
      files,
      selectedFileId: runtime.selectedFileId,
      currentRunState: runtime.currentRunState,
      getShowIntermediate: getShowIntermediateArtifacts,
      selectPipelineFile: getSelectPipelineFile(),
      refreshActions: updateFileActionButtons,
    });
    runtime.selectedFileId = result?.selectedFileId ?? runtime.selectedFileId;
  }

  function handleEvent(event) {
    if (event.type === "STAGE_CHANGED") {
      const from = event?.data?.from || "-";
      const to = event?.data?.to || "STANDBY";
      activateState(to);
      addLog("状态", `${from} -> ${to}`);
      return;
    }
    if (event.type === "LOG_ADDED") {
      const d = event.data || {};
      const lv = d.logType === "ERROR" ? "error" : d.logType === "SUCCESS" ? "success" : "info";
      addLog(d.logType || "INFO", `${d.title || ""} ${d.summary || ""}`.trim(), lv);
      return;
    }
    if (event.type === "TASK_FINISHED") {
      const status = event?.data?.status === "DONE" ? "DONE" : "ERROR";
      activateState(status);
      updateFileTree(Array.isArray(event?.data?.artifacts) ? event.data.artifacts : []);
      addLog("结果", status === "DONE" ? "任务完成" : "任务失败", status === "DONE" ? "success" : "error");
      return;
    }
    if (event.type === "FILE_STAGE_CHANGED") {
      const d = event?.data || {};
      const fileId = d.fileId || "--";
      const status = d.status || "--";
      const err = d.error ? `，原因：${d.error}` : "";
      addLog("文件", `${fileId} -> ${status}${err}`, status === "FAILED" ? "error" : "info");
      if (status === "FAILED") void pullRecentEvents(200);
      getRefreshFilewiseRun()();
      return;
    }
    if (event.type === "FILE_GENERATED") {
      const fileId = event.payload?.fileId || event.data?.fileId;
      updateDagNode(fileId, "done");
      const d = event?.data || {};
      addLog("文件", `${d.fileId || "--"} 已生成，状态=${d.status || "GENERATED"}`, "success");
      getRefreshFilewiseRun()();
      return;
    }
    if (event.type === "FILE_APPROVED") {
      const d = event?.data || {};
      addLog("文件", `${d.fileId || "--"} 已通过`, "success");
      getRefreshFilewiseRun()();
      return;
    }
    if (event.type === "FILE_GENERATING") {
      const fileId = event.payload?.fileId || event.data?.fileId;
      updateDagNode(fileId, "running");
      const d = event?.data || {};
      addLog("文件", `${d.fileId || "--"} 正在生成...`, "info");
      getRefreshFilewiseRun()();
      return;
    }
    if (event.type === "FILE_REGENERATE_REQUESTED") {
      const d = event?.data || {};
      addLog("文件", `${d.fileId || "--"} 请求重新生成...`, "info");
      getRefreshFilewiseRun()();
      return;
    }
    if (event.type === "FILE_REJECTED") {
      const d = event?.data || {};
      addLog("文件", `${d.fileId || "--"} 已驳回${d.reason ? `，原因：${d.reason}` : ""}`, "error");
      getRefreshFilewiseRun()();
      return;
    }
    if (event.type === "RUN_POINTER_MOVED") {
      const d = event?.data || {};
      addLog("指针", `stage=${d.stage || "--"} current=${d.currentFile || "--"}`);
      getRefreshFilewiseRun()();
    }
  }

  return {
    updateWorkspaceProgress,
    activateState,
    renderWorkflowButtons,
    updateFileActionButtons,
    updateFileTree,
    handleEvent,
  };
}
