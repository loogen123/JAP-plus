export function openChatModalAction(ctx) {
  const inputEl = document.getElementById("businessGoalInput");
  const chatInput = document.getElementById("chatInput");
  const goal = (inputEl ? inputEl.value : "").trim();
  if (goal && ctx.getChatMessages().length === 0) {
    chatInput.value = goal;
  }
  ctx.renderChatMessages();
  document.getElementById("chatModal").style.display = "flex";
  setTimeout(() => chatInput.focus(), 100);
}

export function closeChatModalAction() {
  document.getElementById("chatModal").style.display = "none";
}

export function renderChatMessagesAction(ctx) {
  const container = document.getElementById("chatHistory");
  if (!container) return;
  container.innerHTML = `
        <div class="chat-bubble ai">
          你好！我是 J-AP Plus 架构助手。<br><br>
          请告诉我你想做一个什么样的软件？我们可以边聊边构思。如果你已经想得很清楚了，也可以直接输入，然后点击下方的【一键固化为需求草案 (01)】直接立项！
        </div>
      `;
  ctx.getChatMessages().forEach((msg) => {
    const div = document.createElement("div");
    div.className = `chat-bubble ${msg.role === "user" ? "user" : "ai"}`;
    if (msg.role === "ai" && window.marked) {
      div.innerHTML = window.marked.parse(msg.content);
    } else {
      div.textContent = msg.content;
    }
    container.appendChild(div);
  });
  container.scrollTop = container.scrollHeight;
}

export async function sendChatMessageAction(ctx) {
  const inputEl = document.getElementById("chatInput");
  const content = (inputEl.value || "").trim();
  if (!content) return;
  const llm = ctx.buildTaskLlmConfig();
  if (!llm) {
    ctx.addLog("错误", "请先在设置中配置 API Key", "error");
    ctx.openSettings();
    return;
  }
  ctx.appendChatMessage({ role: "user", content });
  inputEl.value = "";
  ctx.renderChatMessages();
  const container = document.getElementById("chatHistory");
  const thinkingDiv = document.createElement("div");
  thinkingDiv.className = "chat-bubble ai";
  thinkingDiv.id = "chatThinking";
  thinkingDiv.innerHTML = `<span style="color:var(--muted)">正在思考...</span>`;
  container.appendChild(thinkingDiv);
  container.scrollTop = container.scrollHeight;
  try {
    const resp = await fetch(ctx.apiBase + "/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: ctx.getChatMessages(),
        llm,
      }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      const tDiv = document.getElementById("chatThinking");
      if (tDiv) tDiv.remove();
      ctx.addLog("错误", data?.message || "对话请求失败", "error");
      return;
    }
    thinkingDiv.id = "";
    thinkingDiv.innerHTML = "";
    let aiFullContent = "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let done = false;
    while (!done) {
      const { value, done: doneReading } = await reader.read();
      done = doneReading;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const rawLine of lines) {
          const line = String(rawLine || "");
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.substring(6);
          if (dataStr === "[DONE]") {
            done = true;
            break;
          }
          try {
            const dataObj = JSON.parse(dataStr);
            const text = dataObj.text || "";
            aiFullContent += text;
            if (window.marked) {
              thinkingDiv.innerHTML = window.marked.parse(aiFullContent);
            } else {
              thinkingDiv.textContent = aiFullContent;
            }
            container.scrollTop = container.scrollHeight;
          } catch {}
        }
      }
    }
    ctx.appendChatMessage({ role: "ai", content: aiFullContent });
  } catch (error) {
    const tDiv = document.getElementById("chatThinking");
    if (tDiv) tDiv.remove();
    ctx.addLog("错误", String(error?.message || error), "error");
  }
}

export async function startDesignOnlyAction(ctx) {
  const chatInputEl = document.getElementById("chatInput");
  const businessGoalEl = document.getElementById("businessGoalInput");
  const chatRequirement = (chatInputEl ? chatInputEl.value : "").trim();
  const businessGoal = (businessGoalEl ? businessGoalEl.value : "").trim();
  if (chatRequirement) {
    ctx.appendChatMessage({ role: "user", content: chatRequirement });
    if (chatInputEl) chatInputEl.value = "";
    ctx.renderChatMessages();
  }
  let finalRequirement = ctx
    .getChatMessages()
    .map((m) => `${m.role === "user" ? "用户" : "AI架构师"}: ${m.content}`)
    .join("\n\n---\n\n");
  if (!finalRequirement && businessGoal) {
    finalRequirement = businessGoal;
  }
  if (!finalRequirement) {
    ctx.addLog("错误", "请先在左侧输入一句话业务点子或与助手对话", "error");
    return;
  }
  const llm = ctx.buildTaskLlmConfig();
  if (!llm) {
    ctx.addLog("错误", "请先在设置中配置 API Key", "error");
    ctx.openSettings();
    return;
  }
  const workspacePath = (document.getElementById("workspacePath").value || "").trim();
  const workspace = workspacePath ? { path: workspacePath } : (ctx.getWorkspacePathConfig() || {});
  ctx.setDesignSubmitting(true);
  ctx.refreshDesignButtonState();
  ctx.addLog("系统", "沙盒模式：正在将多轮对话上下文打包，直接创建设计任务...");
  try {
    const payload = {
      requirement: finalRequirement,
      llm,
      workspace,
      questionnaire: { questions: [] },
      userAnswers: {},
    };
    const resp = await fetch(ctx.apiBase + "/api/v1/tasks/filewise/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      ctx.addLog("错误", data?.message || "任务提交失败", "error");
      return;
    }
    if (data.runId !== ctx.currentRunId) {
      ctx.setRecentEventState({ lastAt: "", cursor: 0 });
    }
    ctx.setCurrentRunId(data.runId);
    ctx.setCurrentTaskId(data.runId);
    ctx.setCurrentRunState(null);
    ctx.setSelectedFileId(null);
    ctx.setTaskIdentity(data.runId, "--");
    ctx.connectWebSocketForTask(data.runId);
    ctx.closeChatModal();
    await ctx.refreshFilewiseRun();
    ctx.addLog("系统", `任务创建成功：${data.runId}`, "success");
    ctx.addLog("系统", "正在自动生成 01_需求草案...");
    await ctx.filewiseGenerateBaseNext();
  } catch (error) {
    ctx.addLog("错误", String(error?.message || error), "error");
  } finally {
    ctx.setDesignSubmitting(false);
    ctx.refreshDesignButtonState();
  }
}
