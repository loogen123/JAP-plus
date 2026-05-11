export function createWebsocketSetup(ctx) {
  const {
    runtime,
    apiBase,
    addLog,
    createWsClient,
    updateWsChip,
    updateAppState,
    getHandleEvent,
    getHandleElicitationResult,
    getWorkspacePath,
  } = ctx;

  function connectWebSocket(taskId) {
    if (!runtime.wsClient) {
      runtime.wsClient = createWsClient({
        getTaskId: () => runtime.currentTaskId,
        setTaskId: (taskIdValue) => { runtime.currentTaskId = taskIdValue; },
        onTaskEvent: (payload) => getHandleEvent()(payload),
        onElicitationResult: (payload) => getHandleElicitationResult()(payload),
        onStatus: (status) => {
          updateWsChip(status);
          updateAppState({ ws: { connected: status === "connected" } });
        },
        onReconnectInfo: (delay, attempt, maxAttempts) => {
          addLog("系统", `WebSocket 已断开，${Math.round(delay / 1000)}秒后尝试重连 (${attempt}/${maxAttempts})...`, "error");
        },
        onReconnectExhausted: () => {
          addLog("系统", "WebSocket 重连失败次数过多，请手动刷新页面", "error");
        },
      });
    }
    runtime.wsClient.connect(taskId);
  }

  function connectWebSocketForTask(taskId) {
    runtime.currentTaskId = taskId || null;
    if (!runtime.wsClient) {
      connectWebSocket(runtime.currentTaskId);
      return;
    }
    runtime.wsClient.connectForTask(runtime.currentTaskId);
  }

  function rememberEventLogKey(key) {
    if (!key) return false;
    if (runtime.recentPrintedEventKeys.has(key)) return true;
    runtime.recentPrintedEventKeys.add(key);
    if (runtime.recentPrintedEventKeys.size > 800) runtime.recentPrintedEventKeys.clear();
    return false;
  }

  function renderRecentEventLine(e) {
    const type = String(e?.type || "");
    const at = String(e?.at || "");
    const key = `${runtime.currentRunId || "--"}|${at}|${type}|${JSON.stringify(e)}`;
    if (rememberEventLogKey(key)) return;
    if (type === "LOG_ADDED") {
      const lv = e?.logType === "ERROR" ? "error" : e?.logType === "SUCCESS" ? "success" : "info";
      addLog(e?.logType || "INFO", `${e?.title || ""} ${e?.summary || ""}`.trim(), lv);
      return;
    }
    if (type === "SDD_FAILURE_SUMMARY") {
      addLog("任务清单失败", `Top3冲突: ${e?.top3 || "无"} | 建议: ${e?.suggestion || "请先修正01-07后重试"}`, "error");
      return;
    }
    if (type === "SDD_GATE_VALIDATED") {
      const passed = e?.passed === true;
      const conflicts = Number(e?.conflicts || 0);
      addLog("架构门禁", passed ? "校验通过" : `校验未通过，冲突数=${conflicts}`, passed ? "success" : "error");
      return;
    }
    if (type === "SDD_CONSTRAINTS_EXTRACTED") {
      addLog("任务生成阶段", `约束已提取 apis=${e?.apis || 0} tables=${e?.tables || 0} states=${e?.stateMachines || 0}`, "info");
      return;
    }
    if (type === "TASKS_SOURCE_IMPORTED") addLog("任务生成阶段", "历史1-7导入完成，开始生成08", "info");
  }

  async function pullRecentEvents(tail = 200) {
    if (!runtime.currentRunId) return;
    const workspacePath = getWorkspacePath();
    const queryParts = [`tail=${encodeURIComponent(String(tail))}`, `cursor=${runtime.recentEventCursor}`];
    if (workspacePath) queryParts.push(`workspace=${encodeURIComponent(workspacePath)}`);
    const query = `?${queryParts.join("&")}`;
    const resp = await fetch(apiBase + `/api/v1/tasks/filewise/${encodeURIComponent(runtime.currentRunId)}/events${query}`, { cache: "no-store" });
    const data = await resp.json();
    if (!resp.ok) return;
    const events = Array.isArray(data?.events) ? data.events : [];
    const latestAt = data?.lastEventAt || "";
    if (data.nextCursor) runtime.recentEventCursor = data.nextCursor;
    const hasNew = latestAt && latestAt !== runtime.recentEventLastAt;
    if (hasNew || events.length > 0) {
      runtime.recentEventLastAt = latestAt || runtime.recentEventLastAt;
      events.slice(-24).forEach((e) => renderRecentEventLine(e));
    }
    return data;
  }

  function stopSddHeartbeat() {
    if (runtime.sddHeartbeatTimer) {
      clearInterval(runtime.sddHeartbeatTimer);
      runtime.sddHeartbeatTimer = null;
    }
  }

  function startSddHeartbeat() {
    stopSddHeartbeat();
    runtime.sddHeartbeatTimer = setInterval(async () => {
      const before = runtime.recentEventLastAt;
      await pullRecentEvents(200);
      if (before && before === runtime.recentEventLastAt) addLog("系统", "仍在生成中");
    }, 30000);
  }

  return {
    connectWebSocket,
    connectWebSocketForTask,
    pullRecentEvents,
    stopSddHeartbeat,
    startSddHeartbeat,
  };
}
