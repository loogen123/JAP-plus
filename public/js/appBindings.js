export function initAppBindings(ctx) {
  const {
    addLog,
    runtime,
    loadSettings,
    setTaskIdentity,
    connectWebSocket,
    activateState,
    renderWorkflowButtons,
    refreshDesignButtonState,
    updateLlmChip,
    updateFileActionButtons,
    renderChatMessages,
    sendChatMessage,
    wrapWithActiveButtonLock,
    handlers,
  } = ctx;

  document.addEventListener("DOMContentLoaded", () => {
    const chatInput = document.getElementById("chatInput");
    if (chatInput) {
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("businessGoalInput").addEventListener("input", refreshDesignButtonState);
    document.getElementById("llmApiKey").addEventListener("input", () => {
      refreshDesignButtonState();
      updateLlmChip(document.getElementById("llmApiKey").value.trim().length > 0);
    });
    document.getElementById("llmBaseUrl").addEventListener("input", refreshDesignButtonState);
    document.getElementById("llmModelName").addEventListener("input", refreshDesignButtonState);
    document.getElementById("filePreview").addEventListener("input", updateFileActionButtons);

    const checkAutofill = () => {
      const apiKeyInput = document.getElementById("llmApiKey");
      if (apiKeyInput && apiKeyInput.value.trim().length > 0) {
        updateLlmChip(true);
        refreshDesignButtonState();
        return true;
      }
      return false;
    };

    let autofillCheckCount = 0;
    const autofillInterval = setInterval(() => {
      if (checkAutofill() || ++autofillCheckCount > 4) clearInterval(autofillInterval);
    }, 500);

    const interactionEvents = ["click", "focusin", "keydown", "mousemove"];
    const onInteract = () => {
      if (checkAutofill()) {
        interactionEvents.forEach((e) => document.removeEventListener(e, onInteract));
      }
    };
    interactionEvents.forEach((e) => document.addEventListener(e, onInteract, { passive: true }));

    loadSettings();
    setTaskIdentity("--", "--");
    connectWebSocket(null);
    activateState("STANDBY");
    renderWorkflowButtons();
    refreshDesignButtonState();
    addLog("系统", "界面已就绪：先点 AI 澄清，再生成设计套件");
  });

  window.addEventListener("error", (e) => {
    addLog("浏览器拦截错误", String(e.message || e.error), "error");
  });
  window.addEventListener("unhandledrejection", (e) => {
    addLog("未处理Promise异常", String(e.reason?.message || e.reason), "error");
  });

  const refreshButtons = () => {
    renderWorkflowButtons();
  };

  handlers.generateQuestionnaire = wrapWithActiveButtonLock(handlers.generateQuestionnaire, refreshButtons);
  handlers.startDesignOnly = wrapWithActiveButtonLock(handlers.startDesignOnly, refreshButtons);
  handlers.filewiseGenerateNext = wrapWithActiveButtonLock(handlers.filewiseGenerateNext, refreshButtons);
  handlers.toggleAutoRun = wrapWithActiveButtonLock(handlers.toggleAutoRun, refreshButtons);
  handlers.sendChatMessage = wrapWithActiveButtonLock(handlers.sendChatMessage, refreshButtons);
  handlers.filewiseSaveEdit = wrapWithActiveButtonLock(handlers.filewiseSaveEdit, refreshButtons);
  handlers.filewiseRegenerate = wrapWithActiveButtonLock(handlers.filewiseRegenerate, refreshButtons);
  handlers.filewiseReject = wrapWithActiveButtonLock(handlers.filewiseReject, refreshButtons);
  handlers.filewiseApprove = wrapWithActiveButtonLock(handlers.filewiseApprove, refreshButtons);
  handlers.chooseWorkspaceFolder = wrapWithActiveButtonLock(handlers.chooseWorkspaceFolder, refreshButtons);
  handlers.testLlmConnection = wrapWithActiveButtonLock(handlers.testLlmConnection, refreshButtons);
  handlers.finishQuestionnaire = wrapWithActiveButtonLock(handlers.finishQuestionnaire, refreshButtons);
  handlers.regenerateFinalRequirement = wrapWithActiveButtonLock(handlers.regenerateFinalRequirement, refreshButtons);
  handlers.chooseHistoryWorkspaceFolder = wrapWithActiveButtonLock(handlers.chooseHistoryWorkspaceFolder, refreshButtons);
  handlers.loadHistoryList = wrapWithActiveButtonLock(handlers.loadHistoryList, refreshButtons);
  handlers.continueFromHistory = wrapWithActiveButtonLock(handlers.continueFromHistory, refreshButtons);
  handlers.chooseTasksSourceWorkspaceFolder = wrapWithActiveButtonLock(handlers.chooseTasksSourceWorkspaceFolder, refreshButtons);
  handlers.loadTasksSourceRuns = wrapWithActiveButtonLock(handlers.loadTasksSourceRuns, refreshButtons);
  handlers.confirmGenerateTasksWithSource = wrapWithActiveButtonLock(handlers.confirmGenerateTasksWithSource, refreshButtons);
  handlers.filewiseGenerateBaseNext = wrapWithActiveButtonLock(handlers.filewiseGenerateBaseNext, refreshButtons);

  Object.assign(window, {
    openSettings: handlers.openSettings,
    closeSettings: handlers.closeSettings,
    clearConsole: handlers.clearConsole,
    generateQuestionnaire: handlers.generateQuestionnaire,
    openChatModal: handlers.openChatModal,
    closeChatModal: handlers.closeChatModal,
    sendChatMessage: handlers.sendChatMessage,
    startDesignOnly: handlers.startDesignOnly,
    openHistoryModal: handlers.openHistoryModal,
    closeHistoryModal: handlers.closeHistoryModal,
    chooseHistoryWorkspaceFolder: handlers.chooseHistoryWorkspaceFolder,
    loadHistoryList: handlers.loadHistoryList,
    continueFromHistory: handlers.continueFromHistory,
    openTasksSourceModal: handlers.openTasksSourceModal,
    closeTasksSourceModal: handlers.closeTasksSourceModal,
    chooseTasksSourceWorkspaceFolder: handlers.chooseTasksSourceWorkspaceFolder,
    loadTasksSourceRuns: handlers.loadTasksSourceRuns,
    confirmGenerateTasksWithSource: handlers.confirmGenerateTasksWithSource,
    filewiseGenerateNext: handlers.filewiseGenerateNext,
    toggleAutoRun: handlers.toggleAutoRun,
    closeFileReviewModal: handlers.closeFileReviewModal,
    filewiseSaveEdit: handlers.filewiseSaveEdit,
    filewiseRegenerate: handlers.filewiseRegenerate,
    filewiseReject: handlers.filewiseReject,
    filewiseApprove: handlers.filewiseApprove,
    validateWorkspace: handlers.validateWorkspace,
    chooseWorkspaceFolder: handlers.chooseWorkspaceFolder,
    testLlmConnection: handlers.testLlmConnection,
    saveSettings: handlers.saveSettings,
    prevQuestion: handlers.prevQuestion,
    nextQuestion: handlers.nextQuestion,
    finishQuestionnaire: handlers.finishQuestionnaire,
    regenerateFinalRequirement: handlers.regenerateFinalRequirement,
    closeFinalizeModal: handlers.closeFinalizeModal,
    confirmFinalRequirement: handlers.confirmFinalRequirement,
    filewiseGenerateBaseNext: handlers.filewiseGenerateBaseNext,
    setModalAnswer: handlers.setModalAnswer,
    toggleModalAnswer: handlers.toggleModalAnswer,
    applyCustomAnswer: handlers.applyCustomAnswer,
    removeCustomAnswer: handlers.removeCustomAnswer,
  });

  runtime.chatMessages = runtime.chatMessages || [];
  renderChatMessages();
}
