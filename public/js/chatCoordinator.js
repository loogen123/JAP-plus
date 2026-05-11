export function createChatCoordinator(ctx) {
  const {
    apiBase,
    runtime,
    addLog,
    openSettings,
    getWorkspacePathConfig,
    refreshDesignButtonState,
    setTaskIdentity,
    connectWebSocketForTask,
    refreshFilewiseRun,
    filewiseGenerateBaseNext,
    openChatModalAction,
    closeChatModalAction,
    renderChatMessagesAction,
    sendChatMessageAction,
    startDesignOnlyAction,
    buildTaskLlmConfig,
  } = ctx;

  function openChatModal() {
    openChatModalAction({ getChatMessages: () => runtime.chatMessages, renderChatMessages });
  }

  function closeChatModal() {
    closeChatModalAction();
  }

  function renderChatMessages() {
    renderChatMessagesAction({ getChatMessages: () => runtime.chatMessages });
  }

  async function sendChatMessage() {
    await sendChatMessageAction({
      apiBase,
      getChatMessages: () => runtime.chatMessages,
      appendChatMessage: (msg) => { runtime.chatMessages.push(msg); },
      renderChatMessages,
      buildTaskLlmConfig,
      addLog,
      openSettings,
    });
  }

  async function startDesignOnly() {
    await startDesignOnlyAction({
      apiBase,
      currentRunId: runtime.currentRunId,
      getChatMessages: () => runtime.chatMessages,
      appendChatMessage: (msg) => { runtime.chatMessages.push(msg); },
      renderChatMessages,
      buildTaskLlmConfig,
      addLog,
      openSettings,
      getWorkspacePathConfig,
      refreshDesignButtonState,
      setDesignSubmitting: (value) => { runtime.designSubmitting = Boolean(value); },
      setRecentEventState: ({ lastAt, cursor }) => {
        if (lastAt !== undefined) runtime.recentEventLastAt = lastAt;
        if (cursor !== undefined) runtime.recentEventCursor = cursor;
      },
      setCurrentRunId: (value) => { runtime.currentRunId = value; },
      setCurrentTaskId: (value) => { runtime.currentTaskId = value; },
      setCurrentRunState: (value) => { runtime.currentRunState = value; },
      setSelectedFileId: (value) => { runtime.selectedFileId = value; },
      setTaskIdentity,
      connectWebSocketForTask,
      closeChatModal,
      refreshFilewiseRun,
      filewiseGenerateBaseNext,
    });
  }

  return {
    openChatModal,
    closeChatModal,
    renderChatMessages,
    sendChatMessage,
    startDesignOnly,
  };
}
