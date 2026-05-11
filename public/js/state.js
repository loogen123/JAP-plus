(() => {
  const appState = {
    taskId: null,
    runtime: {
      currentTaskId: null,
      currentRunId: null,
      currentRunState: null,
      selectedFileId: null,
      isAutoRunning: false,
      finalizedRequirement: "",
      questionnaireLoading: false,
      questionnaireFullyLoaded: false,
      finalizeInProgress: false,
      finalizeModalOpen: false,
      designSubmitting: false,
    },
    dag: { nodes: [] },
    questionnaire: {
      items: [],
      index: 0,
      answers: {},
      customAnswers: {},
      loading: false,
      fullyLoaded: false,
    },
    artifacts: {},
    ws: { connected: false },
    ui: {
      activeTab: "dag",
      lockedButtons: new Set(),
      showIntermediate: false,
    },
    finalizedRequirement: "",
  };

  const listeners = new Map();

  function isObject(input) {
    return input && typeof input === "object" && !Array.isArray(input);
  }

  function deepMerge(target, patch) {
    for (const key of Object.keys(patch || {})) {
      const next = patch[key];
      if (isObject(next) && isObject(target[key])) {
        deepMerge(target[key], next);
      } else {
        target[key] = next;
      }
    }
    return target;
  }

  function getState() {
    return appState;
  }

  function updateState(partial) {
    deepMerge(appState, partial || {});
    for (const [key, callback] of listeners.entries()) {
      if (key === "*" || Object.prototype.hasOwnProperty.call(partial || {}, key)) {
        callback(appState);
      }
    }
  }

  function onStateChange(key, callback) {
    listeners.set(key, callback);
    return () => listeners.delete(key);
  }

  window.JapAppState = {
    getState,
    updateState,
    onStateChange,
  };
})();
