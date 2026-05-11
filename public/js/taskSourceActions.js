export async function confirmGenerateTasksWithSourceAction(ctx) {
  if (!ctx.selectedTasksSourceRunId) {
    ctx.addLog("系统", "请先选择历史流程");
    return;
  }
  const btn = document.getElementById("tasksSourceConfirmBtn");
  btn.disabled = true;
  ctx.closeTasksSourceModal();
  ctx.addLog("系统", `已开始生成任务清单，历史流程=${ctx.selectedTasksSourceRunId}`);
  try {
    if (ctx.currentRunId) {
      ctx.addLog("系统", `在当前任务 ${ctx.currentRunId} 上导入历史1-7并生成任务清单...`);
      await ctx.filewiseGenerateTasks(ctx.selectedTasksSourceRunId);
      ctx.addLog("系统", "任务清单生成流程已提交完成", "success");
    } else {
      const llm = ctx.buildTaskLlmConfig();
      if (!llm) {
        ctx.addLog("错误", "请先在设置中配置 API Key", "error");
        ctx.openSettings();
        ctx.stopSddHeartbeat();
        ctx.setIsGeneratingSdd(false);
        ctx.renderWorkflowButtons();
        return;
      }
      const workspacePath = (document.getElementById("workspacePath").value || "").trim();
      ctx.addLog("系统", "正在基于历史流程创建任务并生成任务清单...");
      ctx.setIsGeneratingSdd(true);
      ctx.renderWorkflowButtons();
      ctx.startSddHeartbeat();
      if (ctx.selectedTasksSourceRunId !== ctx.currentRunId) {
        ctx.setRecentEventState({ lastAt: "", cursor: 0 });
      }
      ctx.setCurrentRunId(ctx.selectedTasksSourceRunId);
      ctx.setCurrentTaskId(ctx.selectedTasksSourceRunId);
      ctx.setTaskIdentity(ctx.selectedTasksSourceRunId, ctx.selectedTasksSourceRunId);
      ctx.connectWebSocketForTask(ctx.selectedTasksSourceRunId);
      const resp = await fetch(ctx.apiBase + "/api/v1/tasks/filewise/generate-sdd-from-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRunId: ctx.selectedTasksSourceRunId,
          llm,
          workspace: workspacePath ? { path: workspacePath } : undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        ctx.addLog("错误", ctx.buildSddErrorMessage(data), "error");
        await ctx.pullRecentEvents(200);
        ctx.stopSddHeartbeat();
        return;
      }
      ctx.setCurrentRunState(data);
      ctx.setRecentEventState({ lastAt: data?.lastEventAt || ctx.recentEventLastAt });
      await ctx.refreshFilewiseRun();
      ctx.addLog("系统", `任务清单生成完成，任务ID=${ctx.selectedTasksSourceRunId}`, "success");
    }
  } catch (error) {
    ctx.addLog("错误", `任务清单生成异常：${String(error?.message || error)}`, "error");
    await ctx.pullRecentEvents(200);
    ctx.stopSddHeartbeat();
  } finally {
    btn.disabled = false;
    ctx.setIsGeneratingSdd(false);
    ctx.renderWorkflowButtons();
  }
}

export async function continueFromHistoryAction(ctx) {
  if (!ctx.selectedHistoryDetail || !ctx.selectedHistoryDetail.requirement?.available) {
    ctx.addLog("错误", "历史任务缺少可用需求文件，无法继续生成", "error");
    return;
  }
  const llm = ctx.buildTaskLlmConfig();
  if (!llm) {
    ctx.addLog("错误", "请先在设置中配置 API Key", "error");
    ctx.openSettings();
    return;
  }
  const workspacePath = ctx.getHistoryWorkspacePath();
  const workspace = workspacePath ? { path: workspacePath } : (ctx.getWorkspacePathConfig() || {});
  try {
    const reqSource = ctx.selectedHistoryDetail?.requirement?.source || "final";
    const requirement = String(ctx.selectedHistoryDetail?.previews?.[reqSource]?.content || "").trim();
    if (!requirement) {
      ctx.addLog("错误", "历史需求内容为空", "error");
      return;
    }
    const resp = await fetch(ctx.apiBase + "/api/v1/tasks/filewise/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirement, llm, workspace }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      ctx.addLog("错误", data?.message || "从历史任务继续生成失败", "error");
      return;
    }
    if (data.runId !== ctx.currentRunId) {
      ctx.setRecentEventState({ lastAt: "", cursor: 0 });
    }
    ctx.setCurrentRunId(data.runId);
    ctx.setCurrentTaskId(data.runId);
    ctx.setTaskIdentity(data.runId, ctx.selectedHistoryDetail.id || "--");
    ctx.connectWebSocketForTask(data.runId);
    await ctx.refreshFilewiseRun();
    ctx.addLog("系统", `新任务ID：${data.runId}，来源任务ID：${ctx.selectedHistoryDetail.id}`, "success");
    ctx.closeHistoryModal();
    ctx.refreshDesignButtonState();
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}
