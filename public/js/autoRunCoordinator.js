export function createAutoRunCoordinator(ctx) {
  const {
    apiBase,
    runtime,
    addLog,
    promptForModules,
    renderWorkflowButtons,
    filewiseGenerateNext,
    filewiseApprove,
    closeFileReviewModal,
    toggleAutoRunAction,
    autoRunLoopAction,
  } = ctx;

  async function toggleAutoRun() {
    await toggleAutoRunAction({
      apiBase,
      isAutoRunning: () => runtime.isAutoRunning,
      setAutoRunning: (value) => { runtime.isAutoRunning = Boolean(value); },
      currentRunId: () => runtime.currentRunId,
      currentRunState: () => runtime.currentRunState,
      patchCurrentRunState: (partial) => {
        if (!runtime.currentRunState) return;
        runtime.currentRunState = { ...runtime.currentRunState, ...partial };
      },
      promptForModules,
      autoRunLoop,
      renderWorkflowButtons,
      addLog,
    });
  }

  async function autoRunLoop() {
    await autoRunLoopAction({
      isAutoRunning: () => runtime.isAutoRunning,
      currentRunId: () => runtime.currentRunId,
      currentRunState: () => runtime.currentRunState,
      addLog,
      toggleAutoRun,
      filewiseGenerateNext,
      filewiseApprove,
      closeFileReviewModal,
    });
  }

  return {
    toggleAutoRun,
    autoRunLoop,
  };
}
