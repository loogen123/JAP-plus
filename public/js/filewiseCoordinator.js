export function createFilewiseCoordinator(ctx) {
  const {
    runtime,
    apiBase,
    addLog,
    buildTaskLlmConfig,
    openSettings,
    renderWorkflowButtons,
    setTaskIdentity,
    connectWebSocketForTask,
    updateFileTree,
    closeFileReviewModal,
    openFileReviewModal,
    buildSddErrorMessage,
    pullRecentEvents,
    startSddHeartbeat,
    stopSddHeartbeat,
    updateFileActionButtons,
    getWorkspacePath,
    filewiseGenerateBaseNextAction,
    filewiseGenerateTasksAction,
    filewiseGenerateNextAction,
    filewiseApproveAction,
    filewiseRejectAction,
    filewiseRegenerateAction,
    filewiseSaveEditAction,
  } = ctx;

  function mapFilewiseStageToUi(stage) {
    if (stage === "MODELING") return "SOLUTION_DESIGN";
    if (stage === "REVIEW") return "QUALITY_REVIEW";
    if (stage === "DETAILING") return "IMPLEMENTATION_BLUEPRINT";
    if (stage === "DONE") return "DONE";
    return "STANDBY";
  }

  async function selectPipelineFile(fileId) {
    runtime.selectedFileId = fileId;
    updateFileTree(runtime.currentRunState?.files || []);
    const workspacePath = getWorkspacePath();
    const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
    try {
      const resp = await fetch(apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(runtime.currentRunId)}/files/${encodeURIComponent(fileId)}/content${query}`, { cache: "no-store" });
      if (resp.ok) {
        const data = await resp.json();
        if (!runtime.filePreviewDirty) {
          document.getElementById("filePreview").value = data.content || "";
        }
      }
    } catch {
      return;
    }
    if (runtime.currentRunState?.currentFile === fileId) {
      const currentFileRec = runtime.currentRunState?.files?.find((f) => f.fileId === fileId);
      if (currentFileRec && (currentFileRec.status === "GENERATED" || currentFileRec.status === "REVIEWING" || currentFileRec.status === "REJECTED")) {
        if (!runtime.isAutoRunning) {
          openFileReviewModal();
        }
      }
    }
  }

  async function _doRefreshFilewiseRun() {
    if (!runtime.currentRunId) return;
    if (runtime.refreshInFlight) {
      runtime.refreshQueued = true;
      return;
    }
    runtime.refreshInFlight = true;
    try {
      do {
        runtime.refreshQueued = false;
        const workspacePath = getWorkspacePath();
        const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
        const resp = await fetch(apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(runtime.currentRunId)}${query}`, { cache: "no-store" });
        const data = await resp.json();
        if (!resp.ok) {
          addLog("错误", data?.message || "读取流水线状态失败", "error");
          renderWorkflowButtons();
          return;
        }
        runtime.currentRunState = data;
        runtime.currentTaskId = data.runId;
        setTaskIdentity(data.runId, document.getElementById("sourceTaskId").textContent || "--");
        ctx.activateState(mapFilewiseStageToUi(data.stage));
        updateFileTree(data.files || []);
        if (data?.sdd?.validation && data.sdd.validation.passed === false) {
          const conflicts = Array.isArray(data.sdd.validation.conflicts) ? data.sdd.validation.conflicts : [];
          const head = conflicts.slice(0, 3).map((c) => `${c.message || ""}${c.location ? ` @${c.location}` : ""}`).filter(Boolean).join("；");
          const action = conflicts.slice(0, 3).map((c) => c.suggestion).filter(Boolean).join("；");
          const gateLogKey = `${data.runId || ""}|${head}|${action}`;
          if (runtime.lastSddGateLogKey !== gateLogKey) {
            addLog("架构门禁", `未通过：${head || "存在一致性冲突"} | 建议：${action || "先修正01-07后重试"}`, "error");
            runtime.lastSddGateLogKey = gateLogKey;
          }
        } else {
          runtime.lastSddGateLogKey = "";
        }
        if (data.currentFile) {
          document.getElementById("previewName").textContent = data.currentFile;
          const currentFileRec = data.files.find((f) => f.fileId === data.currentFile);
          const needsReview = currentFileRec && (currentFileRec.status === "GENERATED" || currentFileRec.status === "REVIEWING" || currentFileRec.status === "REJECTED");
          if (data.currentFileContent !== undefined) {
            if (!runtime.filePreviewDirty) {
              document.getElementById("filePreview").value = data.currentFileContent || "";
            }
            if (needsReview && !runtime.isAutoRunning) {
              openFileReviewModal();
            } else if (!needsReview) {
              closeFileReviewModal();
            }
          } else if (runtime.selectedFileId !== data.currentFile || (needsReview && !runtime.isAutoRunning && document.getElementById("filePreview").value === "")) {
            await selectPipelineFile(data.currentFile);
          } else if (needsReview && !runtime.isAutoRunning) {
            openFileReviewModal();
          } else if (!needsReview) {
            closeFileReviewModal();
          }
        } else {
          document.getElementById("filePreview").value = "";
          closeFileReviewModal();
        }
        document.getElementById("workspaceStatus").textContent = `当前目录：${data.workspacePath || workspacePath || "output"}`;
        document.getElementById("workspacePathLabel").textContent = data.workspacePath || workspacePath || "output";
        if (data.stage === "DONE" || data.status === "DONE") {
          stopSddHeartbeat();
        }
        renderWorkflowButtons();
      } while (runtime.refreshQueued);
    } finally {
      runtime.refreshInFlight = false;
    }
  }

  function refreshFilewiseRun() {
    if (runtime.refreshDebounceTimer) {
      clearTimeout(runtime.refreshDebounceTimer);
    }
    runtime.refreshDebounceTimer = setTimeout(() => {
      _doRefreshFilewiseRun();
    }, 500);
  }

  async function filewiseGenerateBaseNext() {
    await filewiseGenerateBaseNextAction({
      apiBase,
      currentRunId: () => runtime.currentRunId,
      buildTaskLlmConfig,
      openSettings,
      renderWorkflowButtons,
      addLog,
      setGeneratingBase: (value) => { runtime.isGeneratingBase = Boolean(value); },
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      refreshFilewiseRun,
    });
  }

  async function filewiseGenerateTasks(sourceRunId) {
    await filewiseGenerateTasksAction({
      apiBase,
      currentRunId: () => runtime.currentRunId,
      currentRunState: () => runtime.currentRunState,
      buildTaskLlmConfig,
      openSettings,
      renderWorkflowButtons,
      addLog,
      setGeneratingSdd: (value) => { runtime.isGeneratingSdd = Boolean(value); },
      startSddHeartbeat,
      stopSddHeartbeat,
      buildSddErrorMessage,
      pullRecentEvents,
      setRecentEventState: ({ lastAt, cursor }) => {
        if (lastAt !== undefined) runtime.recentEventLastAt = lastAt;
        if (cursor !== undefined) runtime.recentEventCursor = cursor;
      },
      setCurrentRunId: (value) => { runtime.currentRunId = value; },
      setCurrentTaskId: (value) => { runtime.currentTaskId = value; },
      setTaskIdentity,
      connectWebSocketForTask,
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      refreshFilewiseRun,
    }, sourceRunId);
  }

  async function filewiseGenerateNext() {
    await filewiseGenerateNextAction({
      currentRunState: () => runtime.currentRunState,
      filewiseGenerateTasks,
      filewiseGenerateBaseNext,
    });
  }

  async function filewiseApprove(promptForModules) {
    await filewiseApproveAction({
      apiBase,
      currentRunId: () => runtime.currentRunId,
      currentRunState: () => runtime.currentRunState,
      patchCurrentRunState: (partial) => {
        if (!runtime.currentRunState) return;
        runtime.currentRunState = { ...runtime.currentRunState, ...partial };
      },
      promptForModules,
      addLog,
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      refreshFilewiseRun,
    });
  }

  async function filewiseReject() {
    await filewiseRejectAction({
      apiBase,
      currentRunId: () => runtime.currentRunId,
      currentRunState: () => runtime.currentRunState,
      addLog,
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      refreshFilewiseRun,
    });
  }

  async function filewiseRegenerate() {
    await filewiseRegenerateAction({
      apiBase,
      currentRunId: () => runtime.currentRunId,
      currentRunState: () => runtime.currentRunState,
      buildTaskLlmConfig,
      openSettings,
      addLog,
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      refreshFilewiseRun,
    });
  }

  async function filewiseSaveEdit() {
    await filewiseSaveEditAction({
      apiBase,
      currentRunId: () => runtime.currentRunId,
      currentRunState: () => runtime.currentRunState,
      addLog,
      updateFileActionButtons,
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      setFilePreviewDirty: (value) => { runtime.filePreviewDirty = Boolean(value); },
      refreshFilewiseRun,
    });
  }

  return {
    mapFilewiseStageToUi,
    selectPipelineFile,
    refreshFilewiseRun,
    filewiseGenerateBaseNext,
    filewiseGenerateTasks,
    filewiseGenerateNext,
    filewiseApprove,
    filewiseReject,
    filewiseRegenerate,
    filewiseSaveEdit,
  };
}
