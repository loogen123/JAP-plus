export function createHistoryCoordinator(ctx) {
  const {
    apiBase,
    runtime,
    addLog,
    getWorkspacePathConfig,
    getHistoryWorkspacePath,
    fetchHistoryRequirements,
    fetchHistoryRequirementById,
    fetchTasksSourceRuns,
    buildTaskLlmConfig,
    openSettings,
    setTaskIdentity,
    connectWebSocketForTask,
    refreshFilewiseRun,
    refreshDesignButtonState,
    renderWorkflowButtons,
    stopSddHeartbeat,
    startSddHeartbeat,
    buildSddErrorMessage,
    pullRecentEvents,
    filewiseGenerateTasks,
    chooseHistoryWorkspaceFolderAction,
    openHistoryModalAction,
    closeHistoryModalAction,
    chooseTasksSourceWorkspaceFolderAction,
    openTasksSourceModalAction,
    closeTasksSourceModalAction,
    renderTasksSourceRunsAction,
    loadTasksSourceRunsAction,
    confirmGenerateTasksWithSourceAction,
    renderHistoryListAction,
    renderHistoryTabsAction,
    renderHistoryPreviewAction,
    loadHistoryListAction,
    selectHistoryAction,
    continueFromHistoryAction,
    renderTasksSourceRunsView,
    renderHistoryListView,
    renderHistoryTabsView,
    renderHistoryPreviewView,
  } = ctx;

  async function chooseHistoryWorkspaceFolder() {
    await chooseHistoryWorkspaceFolderAction({ apiBase, addLog, loadHistoryList });
  }

  function openHistoryModal() {
    openHistoryModalAction({ getWorkspacePathConfig, loadHistoryList });
  }

  function closeHistoryModal() {
    closeHistoryModalAction();
  }

  async function chooseTasksSourceWorkspaceFolder() {
    await chooseTasksSourceWorkspaceFolderAction({ apiBase, addLog, loadTasksSourceRuns });
  }

  function openTasksSourceModal() {
    openTasksSourceModalAction({ getWorkspacePathConfig, setSelectedTasksSourceRunId: (value) => { runtime.selectedTasksSourceRunId = value; }, loadTasksSourceRuns });
  }

  function closeTasksSourceModal() {
    closeTasksSourceModalAction();
  }

  function renderTasksSourceRuns() {
    renderTasksSourceRunsAction({
      tasksSourceRuns: () => runtime.tasksSourceRuns,
      selectedTasksSourceRunId: () => runtime.selectedTasksSourceRunId,
      setSelectedTasksSourceRunId: (value) => { runtime.selectedTasksSourceRunId = value; },
      renderTasksSourceRuns,
      renderTasksSourceRunsView,
    });
  }

  async function loadTasksSourceRuns() {
    await loadTasksSourceRunsAction({
      apiBase,
      getWorkspacePathConfig,
      fetchTasksSourceRuns,
      addLog,
      setTasksSourceRuns: (value) => { runtime.tasksSourceRuns = value; },
      renderTasksSourceRuns,
    });
  }

  async function confirmGenerateTasksWithSource() {
    await confirmGenerateTasksWithSourceAction({
      selectedTasksSourceRunId: runtime.selectedTasksSourceRunId,
      currentRunId: runtime.currentRunId,
      recentEventLastAt: runtime.recentEventLastAt,
      apiBase,
      addLog,
      closeTasksSourceModal,
      filewiseGenerateTasks,
      buildTaskLlmConfig,
      openSettings,
      stopSddHeartbeat,
      setIsGeneratingSdd: (value) => { runtime.isGeneratingSdd = Boolean(value); },
      renderWorkflowButtons,
      startSddHeartbeat,
      setRecentEventState: ({ lastAt, cursor }) => {
        if (lastAt !== undefined) runtime.recentEventLastAt = lastAt;
        if (cursor !== undefined) runtime.recentEventCursor = cursor;
      },
      setCurrentRunId: (value) => { runtime.currentRunId = value; },
      setCurrentTaskId: (value) => { runtime.currentTaskId = value; },
      setTaskIdentity,
      connectWebSocketForTask,
      buildSddErrorMessage,
      pullRecentEvents,
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      refreshFilewiseRun,
    });
  }

  function renderHistoryList() {
    renderHistoryListAction({ historyRecords: () => runtime.historyRecords, selectedHistory: () => runtime.selectedHistory, selectHistory, renderHistoryListView });
  }

  function renderHistoryTabs() {
    renderHistoryTabsAction({ selectedHistoryPreviewKey: () => runtime.selectedHistoryPreviewKey, setSelectedHistoryPreviewKey: (value) => { runtime.selectedHistoryPreviewKey = value; }, renderHistoryTabs, renderHistoryPreview, renderHistoryTabsView });
  }

  function renderHistoryPreview() {
    renderHistoryPreviewAction({ selectedHistoryDetail: () => runtime.selectedHistoryDetail, selectedHistoryPreviewKey: () => runtime.selectedHistoryPreviewKey, getWorkspacePathConfig, renderHistoryPreviewView });
  }

  async function loadHistoryList() {
    await loadHistoryListAction({
      apiBase,
      getWorkspacePathConfig,
      fetchHistoryRequirements,
      addLog,
      setHistoryRecords: (value) => { runtime.historyRecords = value; },
      setSelectedHistory: (value) => { runtime.selectedHistory = value; },
      setSelectedHistoryDetail: (value) => { runtime.selectedHistoryDetail = value; },
      setSelectedHistoryPreviewKey: (value) => { runtime.selectedHistoryPreviewKey = value; },
      renderHistoryList,
      renderHistoryTabs,
      renderHistoryPreview,
    });
  }

  async function selectHistory(id, type) {
    await selectHistoryAction({
      apiBase,
      getWorkspacePathConfig,
      fetchHistoryRequirementById,
      addLog,
      setSelectedHistory: (value) => { runtime.selectedHistory = value; },
      setSelectedHistoryDetail: (value) => { runtime.selectedHistoryDetail = value; },
      setSelectedHistoryPreviewKey: (value) => { runtime.selectedHistoryPreviewKey = value; },
      renderHistoryList,
      renderHistoryTabs,
      renderHistoryPreview,
    }, id, type);
  }

  async function continueFromHistory() {
    await continueFromHistoryAction({
      selectedHistoryDetail: runtime.selectedHistoryDetail,
      currentRunId: runtime.currentRunId,
      apiBase,
      addLog,
      buildTaskLlmConfig,
      openSettings,
      getHistoryWorkspacePath,
      getWorkspacePathConfig,
      setRecentEventState: ({ lastAt, cursor }) => {
        if (lastAt !== undefined) runtime.recentEventLastAt = lastAt;
        if (cursor !== undefined) runtime.recentEventCursor = cursor;
      },
      setCurrentRunId: (value) => { runtime.currentRunId = value; },
      setCurrentTaskId: (value) => { runtime.currentTaskId = value; },
      setTaskIdentity,
      connectWebSocketForTask,
      refreshFilewiseRun,
      closeHistoryModal,
      refreshDesignButtonState,
    });
  }

  return {
    chooseHistoryWorkspaceFolder,
    openHistoryModal,
    closeHistoryModal,
    chooseTasksSourceWorkspaceFolder,
    openTasksSourceModal,
    closeTasksSourceModal,
    loadTasksSourceRuns,
    confirmGenerateTasksWithSource,
    loadHistoryList,
    continueFromHistory,
  };
}
