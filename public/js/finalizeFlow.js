export function createFinalizeFlow(ctx) {
  const {
    runtime,
    apiBase,
    addLog,
    buildTaskLlmConfig,
    getWorkspacePathConfig,
    getFlattenQuestionnaire,
    normalizeAnswersForApi,
    buildAnswersFingerprint,
    refreshDesignButtonState,
    closeQuestionnaireModal,
    renderCurrentQuestion,
  } = ctx;

  function openFinalizeModal(content) {
    runtime.finalizeModalOpen = true;
    document.getElementById("finalRequirementEditor").value = content || "";
    document.getElementById("finalizeModal").classList.add("show");
    refreshDesignButtonState();
  }

  function closeFinalizeModal() {
    runtime.finalizeModalOpen = false;
    document.getElementById("finalizeModal").classList.remove("show");
    refreshDesignButtonState();
  }

  function scheduleBackgroundFinalize(reason) {
    if (runtime.finalizeDebounceTimer) {
      clearTimeout(runtime.finalizeDebounceTimer);
      runtime.finalizeDebounceTimer = null;
    }
    runtime.finalizeDebounceTimer = setTimeout(() => {
      void runBackgroundFinalize(reason);
    }, 1200);
  }

  async function finalizeRequirementInternal(requirement, llm, options = {}) {
    const workspacePath = (document.getElementById("workspacePath").value || "").trim();
    const workspace = workspacePath ? { path: workspacePath } : (getWorkspacePathConfig() || {});
    const persistDraft = options.persistDraft !== false;
    const resp = await fetch(apiBase + "/api/v1/elicitation/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requirement,
        questionnaire: { questions: getFlattenQuestionnaire() },
        answers: normalizeAnswersForApi(),
        persistDraft,
        llm,
        workspace,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.message || "需求定稿失败");
    return data;
  }

  async function runBackgroundFinalize(reason) {
    if (runtime.backgroundFinalizeRunning) {
      runtime.backgroundFinalizePending = true;
      return;
    }
    const requirement = (document.getElementById("businessGoalInput").value || "").trim();
    const llm = buildTaskLlmConfig();
    if (!requirement || !llm) return;
    runtime.backgroundFinalizeRunning = true;
    const seq = ++runtime.backgroundFinalizeSeq;
    const currentFingerprint = buildAnswersFingerprint();
    try {
      const finalData = await finalizeRequirementInternal(requirement, llm, { persistDraft: false });
      if (seq !== runtime.backgroundFinalizeSeq) return;
      runtime.finalizedRequirement = finalData.finalRequirement || runtime.finalizedRequirement || requirement;
      runtime.lastFinalizedFingerprint = currentFingerprint;
      runtime.lastFinalizedAt = Date.now();
    } catch {
      void reason;
    } finally {
      runtime.backgroundFinalizeRunning = false;
      if (runtime.backgroundFinalizePending) {
        runtime.backgroundFinalizePending = false;
        void runBackgroundFinalize("pending");
      }
    }
  }

  function logFinalizeMeta(data) {
    const meta = data?.meta || {};
    addLog("系统", "========== 定稿阶段执行信息 ==========");
    addLog("系统", `PRD MCP 可用: ${meta.prdMcpAvailable ? "是" : "否"}`);
    addLog("系统", `PRD MCP 尝试调用: ${meta.prdMcpAttempted ? "是" : "否"}`);
    addLog("系统", `PRD MCP 命中工具: ${meta.prdDraftToolName || "(无)"}`);
    if (Array.isArray(meta.availableTools)) addLog("系统", `当前 MCP 可用工具: ${meta.availableTools.join(", ") || "(空)"}`);
    if (meta.prdDraftEnabled) addLog("系统", "本次定稿已吸收 PRD MCP 草案。", "success");
    else addLog("系统", `PRD MCP 未命中，已回退本地定稿逻辑。原因：${meta.prdMcpReason || "未提供"}`, "error");
    if (meta?.prdMcpDiagnosis) {
      const d = meta.prdMcpDiagnosis;
      addLog("系统", `MCP 诊断: ${d.hint || "无"}`);
      addLog("系统", `诊断标记 => 未安装:${d.likelyNotInstalled ? "是" : "否"} 网络问题:${d.likelyNetworkOrRegistry ? "是" : "否"} 运行异常:${d.likelyRuntimeFailure ? "是" : "否"}`);
    }
    if (meta?.draftFiles) {
      const f = meta.draftFiles;
      addLog("系统", `中间文件(runId=${f.runId || "unknown"})`);
      addLog("系统", `- status: ${f.statusPath}`);
      addLog("系统", `- raw: ${f.rawPath}`);
      addLog("系统", `- normalized: ${f.normalizedPath}`);
      addLog("系统", `- finalize_input: ${f.inputPath}`);
      addLog("系统", `- fused_final: ${f.finalPath}`);
    }
    addLog("系统", "=====================================");
  }

  async function regenerateFinalRequirement() {
    const requirement = (document.getElementById("businessGoalInput").value || "").trim();
    const llm = buildTaskLlmConfig();
    if (!llm) {
      addLog("错误", "请先配置 API Key", "error");
      return;
    }
    addLog("系统", "正在重新生成定稿...");
    try {
      const finalData = await finalizeRequirementInternal(requirement, llm, { persistDraft: true });
      runtime.finalizedRequirement = finalData.finalRequirement || runtime.finalizedRequirement || requirement;
      document.getElementById("finalRequirementEditor").value = runtime.finalizedRequirement;
      logFinalizeMeta(finalData);
      runtime.lastFinalizedFingerprint = buildAnswersFingerprint();
      runtime.lastFinalizedAt = Date.now();
      addLog("系统", "定稿已重新生成。", "success");
      refreshDesignButtonState();
    } catch (error) {
      addLog("错误", String(error?.message || error), "error");
    }
  }

  function confirmFinalRequirement() {
    const text = (document.getElementById("finalRequirementEditor").value || "").trim();
    if (!text) {
      addLog("错误", "定稿内容不能为空", "error");
      return;
    }
    runtime.finalizedRequirement = text;
    runtime.lastFinalizedFingerprint = buildAnswersFingerprint();
    runtime.lastFinalizedAt = Date.now();
    closeFinalizeModal();
    addLog("系统", "定稿已确认，可直接启动设计生成。", "success");
    refreshDesignButtonState();
  }

  async function finishQuestionnaire(force = false) {
    const requirement = (document.getElementById("businessGoalInput").value || "").trim();
    const llm = buildTaskLlmConfig();
    if (!llm) {
      addLog("错误", "请先配置 API Key", "error");
      return;
    }
    if (!force && !runtime.questionnaireFullyLoaded) {
      addLog("系统", "题库仍在后台补充，请稍候后再完成问卷。");
      renderCurrentQuestion();
      return;
    }
    runtime.backgroundElicitationStop = true;
    closeQuestionnaireModal();
    if (runtime.finalizeDebounceTimer) {
      clearTimeout(runtime.finalizeDebounceTimer);
      runtime.finalizeDebounceTimer = null;
    }
    const latestFingerprint = buildAnswersFingerprint();
    const canReuseFinalized = runtime.finalizedRequirement && latestFingerprint === runtime.lastFinalizedFingerprint && (Date.now() - runtime.lastFinalizedAt < 15000);
    if (canReuseFinalized) {
      openFinalizeModal(runtime.finalizedRequirement);
      addLog("系统", "需求已在作答过程中实时定稿完成，请确认或编辑后继续。", "success");
      return;
    }
    runtime.finalizeInProgress = true;
    refreshDesignButtonState();
    addLog("系统", "正在补齐最后一次定稿同步...");
    try {
      if (runtime.backgroundFinalizeRunning) {
        const waitStart = Date.now();
        while (runtime.backgroundFinalizeRunning && Date.now() - waitStart < 15000) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      const finalData = await finalizeRequirementInternal(requirement, llm, { persistDraft: true });
      runtime.finalizedRequirement = finalData.finalRequirement || runtime.finalizedRequirement || requirement;
      logFinalizeMeta(finalData);
      runtime.lastFinalizedFingerprint = latestFingerprint;
      runtime.lastFinalizedAt = Date.now();
      openFinalizeModal(runtime.finalizedRequirement);
      addLog("系统", "需求定稿完成，请确认或编辑后继续。", "success");
    } catch (error) {
      addLog("错误", String(error?.message || error), "error");
    } finally {
      runtime.finalizeInProgress = false;
      refreshDesignButtonState();
    }
  }

  return {
    openFinalizeModal,
    closeFinalizeModal,
    scheduleBackgroundFinalize,
    runBackgroundFinalize,
    finalizeRequirementInternal,
    logFinalizeMeta,
    regenerateFinalRequirement,
    confirmFinalRequirement,
    finishQuestionnaire,
  };
}
