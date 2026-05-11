export function createSettingsCoordinator(ctx) {
  const {
    apiBase,
    addLog,
    runtime,
    getSessionLlmConfig,
    setSessionLlmConfig,
    getElicitationMode,
    setElicitationMode,
    getShowIntermediateArtifacts,
    setShowIntermediateArtifacts,
    getWorkspacePathConfig,
    setWorkspacePathConfig,
    updateLlmChip,
    refreshDesignButtonState,
    openSettingsAction,
    closeSettingsAction,
    loadSettingsAction,
    saveSettingsAction,
    testLlmConnectionAction,
    chooseWorkspaceFolderAction,
    buildTaskLlmConfigAction,
    validateWorkspaceAction,
    updateFileTree,
  } = ctx;

  function openSettings() {
    openSettingsAction({ getElicitationMode, getShowIntermediateArtifacts });
  }

  function closeSettings() {
    closeSettingsAction();
  }

  function clearConsole() {
    document.getElementById("logContainer").innerHTML = "";
  }

  function buildTaskLlmConfig() {
    return buildTaskLlmConfigAction({ getSessionLlmConfig, setSessionLlmConfig, updateLlmChip });
  }

  function validateWorkspace() {
    validateWorkspaceAction({ setWorkspacePathConfig });
  }

  function saveSettings() {
    saveSettingsAction({
      buildTaskLlmConfig,
      addLog,
      setElicitationMode,
      setShowIntermediateArtifacts,
      updateLlmChip,
      validateWorkspace,
      closeSettings,
      currentRunState: () => runtime.currentRunState,
      updateFileTree,
    });
  }

  async function chooseWorkspaceFolder() {
    await chooseWorkspaceFolderAction({ apiBase, addLog, validateWorkspace });
  }

  async function testLlmConnection() {
    await testLlmConnectionAction({ apiBase, buildTaskLlmConfig, addLog });
  }

  async function loadSettings() {
    await loadSettingsAction({
      apiBase,
      getSessionLlmConfig,
      getElicitationMode,
      updateLlmChip,
      getWorkspacePathConfig,
      validateWorkspace,
      refreshDesignButtonState,
    });
  }

  return {
    openSettings,
    closeSettings,
    clearConsole,
    buildTaskLlmConfig,
    validateWorkspace,
    saveSettings,
    chooseWorkspaceFolder,
    testLlmConnection,
    loadSettings,
  };
}
