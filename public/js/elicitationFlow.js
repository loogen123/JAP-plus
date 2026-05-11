export function createElicitationFlow(ctx) {
  const {
    runtime,
    apiBase,
    addLog,
    clone,
    normalizeAnswersForApi,
    mergeQuestions,
    renderCurrentQuestionView,
    buildTaskLlmConfig,
    openSettings,
    getElicitationMode,
    getWorkspacePathConfig,
    getOnForceFinish,
  } = ctx;

  function mergeQuestionsIntoState(newQuestions) {
    const merged = mergeQuestions(runtime.activeQuestionnaire, newQuestions);
    runtime.activeQuestionnaire = merged.questions;
    if (runtime.clarificationRounds[0]) runtime.clarificationRounds[0].questions = runtime.activeQuestionnaire;
    return merged.added;
  }

  function handleElicitationResult(data) {
    if (runtime.elicitationResolve) {
      runtime.elicitationResolve(data);
      runtime.elicitationResolve = null;
    }
  }

  async function requestClarificationRound({ requirement, llm, context, workspace, elicitationMode, batchSize, targetTotal, timeoutMs }) {
    return new Promise(async (resolve, reject) => {
      runtime.elicitationResolve = resolve;
      let timer = null;
      const controller = new AbortController();
      try {
        timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
        const resp = await fetch(apiBase + "/api/v1/elicitation/questionnaire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requirement, llm, context, workspace, elicitationMode, batchSize, targetTotal }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const rawText = await resp.text();
          let data;
          try {
            data = rawText ? JSON.parse(rawText) : {};
          } catch {
            const head = rawText ? rawText.slice(0, 240) : "";
            runtime.elicitationResolve = null;
            reject(new Error(`问卷接口返回非JSON（status=${resp.status}）：${head || resp.statusText}`));
            return;
          }
          runtime.elicitationResolve = null;
          reject(new Error(data?.message || `问卷生成失败（status=${resp.status}）`));
        }
      } catch (e) {
        runtime.elicitationResolve = null;
        reject(e);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }

  function renderCurrentQuestion() {
    renderCurrentQuestionView({
      questionnaireLoading: runtime.questionnaireLoading,
      activeQuestionnaire: runtime.activeQuestionnaire,
      questionIndex: runtime.questionIndex,
      answers: runtime.answers,
      customAnswers: runtime.customAnswers,
      questionnaireFullyLoaded: runtime.questionnaireFullyLoaded,
      onForceFinish: () => getOnForceFinish()(true),
    });
  }

  function openQuestionnaireModal() {
    document.getElementById("questionnaireModal").classList.add("show");
    renderCurrentQuestion();
  }

  function closeQuestionnaireModal() {
    runtime.backgroundElicitationStop = true;
    if (runtime.progressiveAppendTimer) {
      clearInterval(runtime.progressiveAppendTimer);
      runtime.progressiveAppendTimer = null;
    }
    document.getElementById("questionnaireModal").classList.remove("show");
  }

  async function generateQuestionnaire() {
    const inputEl = document.getElementById("businessGoalInput");
    const chatInputEl = document.getElementById("chatInput");
    let requirement = (inputEl ? inputEl.value : "").trim();
    if (!requirement) {
      requirement = (chatInputEl ? chatInputEl.value : "").trim() || runtime.chatMessages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n---\n\n");
    }
    if (!requirement) {
      addLog("错误", "请先在左侧输入框或沙盒对话中输入一句话业务点子", "error");
      return;
    }
    const llm = buildTaskLlmConfig();
    if (!llm) {
      addLog("错误", "请先在设置中配置 API Key", "error");
      openSettings();
      return;
    }
    const elicitationMode = getElicitationMode();
    runtime.clarificationPlan = null;
    runtime.clarificationRounds = [];
    runtime.activeQuestionnaire = [];
    runtime.finalizedRequirement = requirement;
    runtime.questionnaireFullyLoaded = false;
    runtime.questionnaireLoading = true;
    runtime.backgroundElicitationStop = false;
    Object.keys(runtime.answers).forEach((k) => delete runtime.answers[k]);
    Object.keys(runtime.customAnswers).forEach((k) => delete runtime.customAnswers[k]);
    if (runtime.progressiveAppendTimer) {
      clearInterval(runtime.progressiveAppendTimer);
      runtime.progressiveAppendTimer = null;
    }
    const workspacePath = (document.getElementById("workspacePath").value || "").trim();
    const workspace = workspacePath ? { path: workspacePath } : (getWorkspacePathConfig() || {});
    const targetTotal = 100;
    const firstBatchSize = elicitationMode === "deep" ? 8 : 6;
    const backgroundBatchSize = elicitationMode === "deep" ? 8 : 6;
    const requestTimeoutMs = elicitationMode === "deep" ? 120000 : 90000;
    openQuestionnaireModal();
    addLog("系统", `AI 正在发起澄清（${elicitationMode === "deep" ? "深度" : "快速"}模式）...`);
    try {
      const data = await requestClarificationRound({ requirement, llm, context: {}, workspace, elicitationMode, batchSize: firstBatchSize, targetTotal, timeoutMs: requestTimeoutMs });
      runtime.clarificationPlan = data;
      runtime.finalizedRequirement = data.refinedRequirement || runtime.finalizedRequirement;
      if (data?.meta?.timingMs) {
        const t = data.meta.timingMs;
        addLog("系统", `澄清耗时：总 ${t.total}ms，上下文 ${t.context}ms，深度思考 ${t.deepThinking}ms，结构化 ${t.structured}ms`);
      }
      if (data?.meta?.batch?.droppedAsDuplicate > 0) addLog("系统", `已自动去重 ${data.meta.batch.droppedAsDuplicate} 道重复问题`);
      if (data?.fallback) addLog("系统", "问卷已切换到快速兜底模式，避免长时间阻塞。", "success");
      const returnedQuestions = data.questionnaire?.questions || [];
      if (data.clarityReached || !Array.isArray(returnedQuestions) || returnedQuestions.length === 0) {
        runtime.questionnaireLoading = false;
        runtime.questionnaireFullyLoaded = true;
        closeQuestionnaireModal();
        addLog("系统", "AI 判断需求已足够清晰，无需继续提问。", "success");
        return;
      }
      runtime.activeQuestionnaire = [];
      runtime.clarificationRounds = [{ round: 1, questions: runtime.activeQuestionnaire }];
      runtime.questionIndex = 0;
      runtime.questionnaireLoading = false;
      mergeQuestionsIntoState(clone(returnedQuestions));
      renderCurrentQuestion();
      addLog("系统", `首批题目已就绪：${runtime.activeQuestionnaire.length}/${targetTotal}`, "success");
      const runBackgroundPrefetch = async () => {
        let guard = 0;
        while (!runtime.backgroundElicitationStop && runtime.activeQuestionnaire.length < targetTotal && guard < 12) {
          guard += 1;
          addLog("系统", `后台补充题库中... 第 ${guard} 批（当前 ${runtime.activeQuestionnaire.length}/${targetTotal}）`);
          try {
            const nextData = await requestClarificationRound({
              requirement,
              llm,
              workspace,
              elicitationMode,
              batchSize: backgroundBatchSize,
              targetTotal,
              timeoutMs: requestTimeoutMs,
              context: {
                refinedRequirement: runtime.finalizedRequirement || requirement,
                previousRounds: [{ round: 1, questions: runtime.activeQuestionnaire }],
                answers: normalizeAnswersForApi(),
              },
            });
            runtime.finalizedRequirement = nextData?.refinedRequirement || runtime.finalizedRequirement;
            const nextQuestions = nextData?.questionnaire?.questions || [];
            const added = mergeQuestionsIntoState(nextQuestions);
            renderCurrentQuestion();
            if (nextData?.meta?.timingMs) {
              const t = nextData.meta.timingMs;
              addLog("系统", `后台批次耗时：总 ${t.total}ms（结构化 ${t.structured}ms）`);
            }
            if (nextData?.meta?.batch?.droppedAsDuplicate > 0) addLog("系统", `后台批次已去重 ${nextData.meta.batch.droppedAsDuplicate} 道问题`);
            if (added === 0 || nextData.clarityReached) {
              runtime.questionnaireFullyLoaded = true;
              renderCurrentQuestion();
              addLog("系统", `问卷补充完成，共 ${runtime.activeQuestionnaire.length} 题。`, "success");
              return;
            }
          } catch {
            addLog("系统", "后台补题已停止（超时或无新增），不影响当前作答。");
            runtime.questionnaireFullyLoaded = true;
            renderCurrentQuestion();
            return;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        runtime.questionnaireFullyLoaded = true;
        renderCurrentQuestion();
        addLog("系统", `问卷补充结束，当前共 ${runtime.activeQuestionnaire.length} 题。`, "success");
      };
      void runBackgroundPrefetch();
    } catch (error) {
      runtime.questionnaireLoading = false;
      const message = String(error?.message || error);
      closeQuestionnaireModal();
      if (message.toLowerCase().includes("aborted")) {
        addLog("错误", "问卷请求超时，请重试（已启用快速超时保护）", "error");
        return;
      }
      addLog("错误", message, "error");
    }
  }

  return {
    mergeQuestionsIntoState,
    handleElicitationResult,
    requestClarificationRound,
    generateQuestionnaire,
    openQuestionnaireModal,
    closeQuestionnaireModal,
    renderCurrentQuestion,
  };
}
