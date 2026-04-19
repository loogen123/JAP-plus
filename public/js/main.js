    const API_BASE = "";
    const SESSION_LLM_CONFIG_KEY = "jap.llm.session.config";
    const LOCAL_WORKSPACE_PATH_KEY = "jap.workspace.path";
    const SESSION_ELICITATION_MODE_KEY = "jap.elicitation.mode";
    const LOCAL_WORKFLOW_MODE_KEY = "jap.workflow.mode";
      const LOCAL_SHOW_INTERMEDIATE_ARTIFACTS_KEY = "jap.ui.showIntermediateArtifacts";
    const STATE_ORDER = ["STANDBY","DISCOVERY","SOLUTION_DESIGN","QUALITY_REVIEW","IMPLEMENTATION_BLUEPRINT","DELIVERY_RELEASE","DONE","ERROR"];
    const STATE_LABEL_MAP = {
      STANDBY: "待命",
      DISCOVERY: "需求澄清",
      SOLUTION_DESIGN: "方案建模",
      QUALITY_REVIEW: "质量审阅",
      IMPLEMENTATION_BLUEPRINT: "实施蓝图",
      DELIVERY_RELEASE: "交付发布",
      DONE: "已完成",
      ERROR: "异常"
    };
    let ws = null;
    let wsReconnectTimer = null;
    let currentTaskId = null;
    let clarificationPlan = null;
    let clarificationRounds = [];
    let activeQuestionnaire = [];
    let questionIndex = 0;
    const answers = {};
    const customAnswers = {};
    let finalizedRequirement = "";
    let questionnaireLoading = false;
    let questionnaireFullyLoaded = false;
    let finalizeInProgress = false;
    let progressiveAppendTimer = null;
    let backgroundElicitationStop = false;
    let finalizeDebounceTimer = null;
    let backgroundFinalizeRunning = false;
    let backgroundFinalizePending = false;
    let backgroundFinalizeSeq = 0;
    let lastFinalizedFingerprint = "";
    let lastFinalizedAt = 0;
    let finalizeModalOpen = false;
    let designSubmitting = false;
    let historyRecords = [];
    let selectedHistory = null;
    let selectedHistoryDetail = null;
    let selectedHistoryPreviewKey = "final";
    let currentRunId = null;
    let currentRunState = null;
    let selectedFileId = null;
    let isAutoRunning = false;
    let sddSourceRuns = [];
    let selectedSddSourceRunId = null;
    let recentEventLastAt = "";
    let recentEventCursor = 0;
    let sddHeartbeatTimer = null;
    let lastSddGateLogKey = "";
    let isGeneratingBase = false;
    let isGeneratingSdd = false;
    let refreshInFlight = false;
    let refreshQueued = false;
    let refreshDebounceTimer = null;
    let filePreviewDirty = false;
    const recentPrintedEventKeys = new Set();

    function clone(obj){ return JSON.parse(JSON.stringify(obj)); }
    function normalizeAnswersForApi(){
      const out = {};
      const allKeys = new Set([...Object.keys(answers), ...Object.keys(customAnswers)]);
      allKeys.forEach((k) => {
        const aiAns = answers[k];
        const custAns = customAnswers[k] || [];
        if(Array.isArray(aiAns)){
          out[k] = [...aiAns, ...custAns];
        } else {
          const base = aiAns !== undefined ? String(aiAns) : "";
          if(custAns.length > 0){
            out[k] = base ? `${base}。补充：${custAns.join("；")}` : custAns.join("；");
          } else {
            out[k] = base;
          }
        }
      });
      return out;
    }
    function buildAnswersFingerprint(){
      const normalized = normalizeAnswersForApi();
      const keys = Object.keys(normalized).sort();
      const parts = keys.map((k)=>{
        const v = normalized[k];
        if(Array.isArray(v)) return `${k}:${[...v].sort().join("|")}`;
        return `${k}:${String(v)}`;
      });
      return parts.join(";");
    }
    function getFlattenQuestionnaire(){
      const list = [];
      clarificationRounds.forEach((r)=>{ (r.questions||[]).forEach((q)=>list.push(q)); });
      return list;
    }
    function hasAvailableLlmConfig(){
      const key = (document.getElementById("llmApiKey").value||"").trim();
      if(key) return true;
      const cached=getSessionLlmConfig();
      return Boolean((cached?.apiKey||"").trim());
    }
    function canStartDesign(){
      const baseRequirement = (finalizedRequirement||"").trim() || (document.getElementById("businessGoalInput").value||"").trim();
      return Boolean(baseRequirement) && !finalizeInProgress && !finalizeModalOpen && !designSubmitting && hasAvailableLlmConfig();
    }
    function refreshDesignButtonState(){
      const btn = document.getElementById("designBtn");
      const enabled = canStartDesign();
      btn.disabled = !enabled;
      btn.className = `btn ${enabled ? "btn-primary" : "btn-light"}`;
    }
    function setTaskIdentity(taskId, sourceId){
      document.getElementById("currentTaskId").textContent = taskId || "--";
      document.getElementById("sourceTaskId").textContent = sourceId || "--";
    }

    function openSettings(){ 
      document.getElementById("testConnResult").style.display = "none";
      document.getElementById("elicitationMode").value = getElicitationMode();
        const showEl = document.getElementById("showIntermediateArtifacts");
        if(showEl) showEl.checked = getShowIntermediateArtifacts();
      const settingsModal = document.getElementById("settingsModal");
      const historyModal = document.getElementById("historyModal");
      // 当历史任务弹窗打开时，确保设置弹窗叠在其上层显示
      if (historyModal?.classList.contains("show")) {
        settingsModal.style.zIndex = "90";
      } else {
        settingsModal.style.zIndex = "";
      }
      settingsModal.classList.add("show"); 
    }
    function closeSettings(){
      const settingsModal = document.getElementById("settingsModal");
      settingsModal.classList.remove("show");
      settingsModal.style.zIndex = "";
    }
    function clearConsole(){ document.getElementById("logContainer").innerHTML = ""; }

    function getSessionLlmConfig(){ try { const raw=sessionStorage.getItem(SESSION_LLM_CONFIG_KEY); return raw?JSON.parse(raw):null; } catch { return null; } }
    function setSessionLlmConfig(config){ if(config?.apiKey){ sessionStorage.setItem(SESSION_LLM_CONFIG_KEY, JSON.stringify(config)); } }
    function getElicitationMode(){ const mode=sessionStorage.getItem(SESSION_ELICITATION_MODE_KEY); return mode==="deep"?"deep":"quick"; }
    function setElicitationMode(mode){ sessionStorage.setItem(SESSION_ELICITATION_MODE_KEY, mode==="deep"?"deep":"quick"); }
    function getWorkflowMode(){ return "filewise"; }
    function setWorkflowMode(mode){ localStorage.setItem(LOCAL_WORKFLOW_MODE_KEY, mode==="legacy"?"legacy":"filewise"); }
    function getWorkspacePathConfig(){ const p=localStorage.getItem(LOCAL_WORKSPACE_PATH_KEY); return p?{path:p}:null; }
    function setWorkspacePathConfig(path){ if(!path){ localStorage.removeItem(LOCAL_WORKSPACE_PATH_KEY); return; } localStorage.setItem(LOCAL_WORKSPACE_PATH_KEY,path); }
      function getShowIntermediateArtifacts(){ const v=localStorage.getItem(LOCAL_SHOW_INTERMEDIATE_ARTIFACTS_KEY); return v===null?true:v==="1"; }
      function setShowIntermediateArtifacts(enabled){ localStorage.setItem(LOCAL_SHOW_INTERMEDIATE_ARTIFACTS_KEY, enabled?"1":"0"); }

    function updateLlmChip(ok){ const el=document.getElementById("llmChip"); el.className="chip "+(ok?"green":"red"); el.textContent=ok?"LLM: configured":"LLM: not configured"; }
    function updateWsChip(status){ const el=document.getElementById("wsChip"); el.className="chip "+(status==="connected"?"green":status==="disconnected"?"red":""); el.textContent="WebSocket: "+status; }

    let wsPingTimer = null;

    function connectWebSocket(taskId){
      if(taskId!==undefined&&taskId!==null) currentTaskId=taskId;
      if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
      if(wsReconnectTimer){ clearTimeout(wsReconnectTimer); wsReconnectTimer=null; }
      if(wsPingTimer){ clearInterval(wsPingTimer); wsPingTimer=null; }
      
      updateWsChip("connecting");
      const protocol = window.location.protocol==="https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      
      ws.onopen = () => {
        updateWsChip("connected");
        wsPingTimer = setInterval(() => {
          if(ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);
      };
      ws.onmessage = (event) => {
        let payload; try { payload = JSON.parse(event.data); } catch { return; }
        if(payload.type === "elicitation-result") {
          if(typeof handleElicitationResult === "function") handleElicitationResult(payload.payload || payload.data);
          return;
        }
        const eventTaskId = payload?.data?.taskId ?? null;
        if(eventTaskId!==currentTaskId) return;
        handleEvent(payload);
      };
      ws.onerror = () => updateWsChip("disconnected");
      ws.onclose = () => { 
        addLog("系统", "WebSocket 已断开，正在重连...", "error");
        updateWsChip("disconnected"); 
        if(wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer=null; }
        ws=null; 
        wsReconnectTimer=setTimeout(()=>connectWebSocket(currentTaskId),3000); 
      };
    }
    function connectWebSocketForTask(taskId){ currentTaskId=taskId||null; connectWebSocket(currentTaskId); }

    function esc(s){ return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\"","&quot;").replaceAll("'","&#39;"); }
    function addLog(tag,msg,level="info"){ 
      const root=document.getElementById("logContainer"); 
      const color=level==="success"?"#2c9a58":level==="error"?"#d35a68":"#5673a0"; 
      const line=document.createElement("div"); 
      line.className="log-line"; 
      line.innerHTML=`<span style="color:#7f8ca5;margin-right:8px;">[${new Date().toLocaleTimeString()}]</span><span style="color:${color};font-weight:700;">${esc(tag)}</span> ${esc(msg)}`; 
      root.appendChild(line); 
      // phase-d limit log size
      if(root.childElementCount > 1000) {
        root.removeChild(root.firstElementChild);
      }
      root.scrollTop=root.scrollHeight; 
    }
    function buildSddErrorMessage(data){
      const code = data?.errorCode || "SDD_GENERATION_FAILED";
      const stage = data?.stage || "DETAILING";
      const lastEventAt = data?.lastEventAt ? ` lastEventAt=${data.lastEventAt}` : "";
      const msg = data?.message || "SDD生成失败";
      return `[${code}] stage=${stage}${lastEventAt} | ${msg}`;
    }
    function rememberEventLogKey(key){
      if(!key) return false;
      if(recentPrintedEventKeys.has(key)) return true;
      recentPrintedEventKeys.add(key);
      if(recentPrintedEventKeys.size > 800){
        recentPrintedEventKeys.clear();
      }
      return false;
    }
    function renderRecentEventLine(e){
      const type = String(e?.type || "");
      const at = String(e?.at || "");
      const key = `${currentRunId || "--"}|${at}|${type}|${JSON.stringify(e)}`;
      if(rememberEventLogKey(key)) return;
      if(type === "LOG_ADDED"){
        const lv = e?.logType === "ERROR" ? "error" : e?.logType === "SUCCESS" ? "success" : "info";
        addLog(e?.logType || "INFO", `${e?.title || ""} ${e?.summary || ""}`.trim(), lv);
        return;
      }
      if(type === "SDD_FAILURE_SUMMARY"){
        addLog("SDD失败",`Top3冲突: ${e?.top3 || "无"} | 建议: ${e?.suggestion || "请先修正01-07后重试"}`,"error");
        return;
      }
      if(type === "SDD_GATE_VALIDATED"){
        const passed = e?.passed === true;
        const conflicts = Number(e?.conflicts || 0);
        addLog("SDD Gate", passed ? "校验通过" : `校验未通过，冲突数=${conflicts}`, passed ? "success" : "error");
        return;
      }
      if(type === "SDD_CONSTRAINTS_EXTRACTED"){
        addLog("SDD阶段",`约束已提取 apis=${e?.apis || 0} tables=${e?.tables || 0} states=${e?.stateMachines || 0}`,"info");
        return;
      }
      if(type === "SDD_SOURCE_IMPORTED"){
        addLog("SDD阶段","历史1-7导入完成，开始生成08","info");
      }
    }
    async function pullRecentEvents(tail=200){
      if(!currentRunId) return;
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const queryParts = [`tail=${encodeURIComponent(String(tail))}`, `cursor=${recentEventCursor}`];
      if(workspacePath) queryParts.push(`workspace=${encodeURIComponent(workspacePath)}`);
      const query = `?${queryParts.join("&")}`;
      const resp = await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/events${query}`,{ cache:"no-store" });
      const data = await resp.json();
      if(!resp.ok) return;
      const events = Array.isArray(data?.events) ? data.events : [];
      const latestAt = data?.lastEventAt || "";
      if(data.nextCursor) {
        recentEventCursor = data.nextCursor;
      }
      const hasNew = latestAt && latestAt !== recentEventLastAt;
      if(hasNew || events.length > 0){
        recentEventLastAt = latestAt || recentEventLastAt;
        const tailEvents = events.slice(-24); // Still limit rendering to last 24 if too many arrive at once
        tailEvents.forEach((e)=>renderRecentEventLine(e));
      }
      return data;
    }
    function stopSddHeartbeat(){
      if(sddHeartbeatTimer){ clearInterval(sddHeartbeatTimer); sddHeartbeatTimer = null; }
    }
    function startSddHeartbeat(){
      stopSddHeartbeat();
      sddHeartbeatTimer = setInterval(async ()=>{
        const before = recentEventLastAt;
        await pullRecentEvents(200);
        if(before && before === recentEventLastAt){
          addLog("系统","仍在生成中");
        }
      }, 30000);
    }

    function updateWorkspaceProgress(stage){ const idx=Math.max(0,STATE_ORDER.indexOf(stage)); const pct=Math.round((idx/(STATE_ORDER.length-2))*100); const v=stage==="ERROR"?100:Math.min(100,Math.max(0,pct)); document.getElementById("workspaceProgressBar").style.width=`${v}%`; document.getElementById("workspaceProgressText").textContent=`${v}%`; document.getElementById("workspaceStage").textContent=stage; }

    function activateState(stateName){
      const target=STATE_ORDER.includes(stateName)?stateName:"STANDBY"; const idx=STATE_ORDER.indexOf(target);
      document.querySelectorAll(".state-node").forEach((node)=>{ const s=node.dataset.state; const rect=node.querySelector("rect"); if(!s||!rect) return; const sIdx=STATE_ORDER.indexOf(s); const active=s===target; const done=sIdx>-1&&sIdx<idx&&s!=="ERROR"; node.classList.toggle("active",active); if(target==="ERROR"&&s==="ERROR"){ rect.setAttribute("fill","#ffecef"); rect.setAttribute("stroke","#ef9ca8"); rect.setAttribute("stroke-width","2"); } else if(active){ rect.setAttribute("fill","#ebf3ff"); rect.setAttribute("stroke","#6aa6ff"); rect.setAttribute("stroke-width","2.6"); } else if(done){ rect.setAttribute("fill","#ecfbf1"); rect.setAttribute("stroke","#79c79a"); rect.setAttribute("stroke-width","1.5"); } else { rect.setAttribute("fill","#fff"); rect.setAttribute("stroke","#d7e2f3"); rect.setAttribute("stroke-width","1.2"); } });
      document.querySelectorAll(".state-arrow").forEach((arrow)=>{ const from=arrow.dataset.from, to=arrow.dataset.to; const f=STATE_ORDER.indexOf(from), t=STATE_ORDER.indexOf(to); const activePath=f>-1&&t>-1&&t<=idx&&target!=="ERROR"; const retryPath=target==="SOLUTION_DESIGN"&&from==="QUALITY_REVIEW"&&to==="SOLUTION_DESIGN"; arrow.setAttribute("stroke", activePath||retryPath?"#6aa6ff":"#9cb0cc"); });
      const label = STATE_LABEL_MAP[target] || target;
      document.getElementById("stateStatusText").innerHTML = `当前阶段：<strong>${label}</strong> (${target})`;
      document.getElementById("stateStatusDot").style.background = target==="ERROR" ? "#e56a6a" : target==="DONE" ? "#2fb267" : "#6aa6ff";
      updateWorkspaceProgress(target);
    }

    function renderWorkflowButtons(){
      const actions = currentRunState?.actions || {};
      const currentFile = currentRunState?.currentFile || null;
      const busy = isGeneratingBase || isGeneratingSdd;
      const canGenerateBase = Boolean(actions.canGenerateNext && currentFile && currentFile !== "08");
      const canGenerateSdd = Boolean(actions.canGenerateNext && currentFile === "08");
      const hasSelectedSddSource = Boolean(selectedSddSourceRunId);
      const canStartAuto = Boolean(
        currentRunId &&
        currentRunState &&
        currentRunState.stage !== "DONE" &&
        currentFile &&
        currentFile !== "08",
      );

      const baseBtn = document.getElementById("btnGenerateBase");
      const sddBtn = document.getElementById("btnGenerateSdd");
      const sddCurrentBtn = document.getElementById("btnGenerateSddCurrent");
      const autoBtn = document.getElementById("btnAutoRun");

      if (baseBtn) {
        baseBtn.disabled = busy || !canGenerateBase;
      }
      if (sddBtn) {
        sddBtn.disabled = busy;
        sddBtn.innerText = isGeneratingSdd ? "生成中..." : "生成SDD文件(历史流程)";
      }
      if (sddCurrentBtn) {
        sddCurrentBtn.disabled = busy || !canGenerateSdd;
        sddCurrentBtn.innerText = isGeneratingSdd ? "生成中..." : "根据当前任务继续生成SDD";
      }
      if (autoBtn) {
        if (isAutoRunning) {
          autoBtn.textContent = "停止自动生成";
          autoBtn.style.background = "#fff7f7";
          autoBtn.style.color = "#d85555";
          autoBtn.style.borderColor = "#f1c3c3";
          autoBtn.disabled = busy;
        } else {
          autoBtn.textContent = "一键自动生成前7文件 (免审核)";
          autoBtn.style.background = "#f2f7ff";
          autoBtn.style.color = "#2f5d9e";
          autoBtn.style.borderColor = "#a8c5ff";
          autoBtn.disabled = busy || !canStartAuto;
        }
      }
    }
    function updateFileActionButtons(){
      const actions = currentRunState?.actions || {};
      const previewText = (document.getElementById("filePreview")?.value || "").trim();
      document.getElementById("btnApprove").disabled = !actions.canApprove;
      document.getElementById("btnReject").disabled = !actions.canReject;
      document.getElementById("btnRegenerate").disabled = !actions.canRegenerate;
      document.getElementById("btnSaveEdit").disabled = !actions.canSaveEdit || !previewText;
      renderWorkflowButtons();
    }
    function updateFileTree(files){
      const tree=document.getElementById("fileTree"), preview=document.getElementById("filePreview"), count=document.getElementById("artifactCount");
      if(!Array.isArray(files)||files.length===0){
        tree.textContent="暂无生成文件";
        preview.value="";
        count.textContent="0 个";
        document.getElementById("previewName").textContent="--";
        updateFileActionButtons();
        return;
      }
      if(typeof files[0] === "string"){
        count.textContent=`${files.length} 个`;
        tree.innerHTML=files.map((name)=>`<div style="padding:6px 4px;border-bottom:1px dashed #e8eef9;">${esc(name)}</div>`).join("");
        document.getElementById("previewName").textContent=String(files[0]||"--");
        preview.value = files.join("\n");
        updateFileActionButtons();
        return;
      }
        const showIntermediate = getShowIntermediateArtifacts();
        const hasSdd = files.some((f)=>f.fileId==="08");
        const visibleFiles = (!showIntermediate && hasSdd) ? files.filter((f)=>f.fileId==="08") : files;
        count.textContent=`${visibleFiles.length} 个`;
        if(!selectedFileId || !visibleFiles.some((f)=>f.fileId===selectedFileId)) selectedFileId = visibleFiles[0].fileId;
        tree.innerHTML=visibleFiles.map((f)=>{
        const active=f.fileId===selectedFileId?"background:#eef4ff;":"";
        const stage=f.fileId===currentRunState?.currentFile?" ⭐":"";
        return `<div onclick="selectPipelineFile('${esc(f.fileId)}')" style="padding:6px 4px;border-bottom:1px dashed #e8eef9;cursor:pointer;${active}">${esc(f.fileId)} · ${esc(f.status)}${stage}</div>`;
      }).join("");
        const selected = visibleFiles.find((f)=>f.fileId===selectedFileId) || visibleFiles[0];
      document.getElementById("previewName").textContent = `${selected.fileId} ${selected.artifactName}`;
      updateFileActionButtons();
    }
    function handleEvent(event){
      if(event.type==="STAGE_CHANGED"){
        const from=event?.data?.from||"-", to=event?.data?.to||"STANDBY";
        activateState(to);
        addLog("状态",`${from} -> ${to}`);
        return;
      }
      if(event.type==="LOG_ADDED"){
        const d=event.data||{};
        const lv=d.logType==="ERROR"?"error":d.logType==="SUCCESS"?"success":"info";
        addLog(d.logType||"INFO",`${d.title||""} ${d.summary||""}`.trim(),lv);
        return;
      }
      if(event.type==="TASK_FINISHED"){
        const status=event?.data?.status==="DONE"?"DONE":"ERROR";
        activateState(status);
        updateFileTree(Array.isArray(event?.data?.artifacts)?event.data.artifacts:[]);
        addLog("结果",status==="DONE"?"任务完成":"任务失败",status==="DONE"?"success":"error");
        return;
      }
      if(event.type==="FILE_STAGE_CHANGED"){
        const d=event?.data||{};
        const fileId=d.fileId||"--";
        const status=d.status||"--";
        const err=d.error?`，原因：${d.error}`:"";
        addLog("文件",`${fileId} -> ${status}${err}`,status==="FAILED"?"error":"info");
        if(status==="FAILED"){ void pullRecentEvents(200); }
        refreshFilewiseRun();
        return;
      }
      if(event.type==="FILE_GENERATED"){
        const d=event?.data||{};
        addLog("文件",`${d.fileId||"--"} 已生成，状态=${d.status||"GENERATED"}`,"success");
        refreshFilewiseRun();
        return;
      }
      if(event.type==="FILE_APPROVED"){
        const d=event?.data||{};
        addLog("文件",`${d.fileId||"--"} 已通过`,"success");
        refreshFilewiseRun();
        return;
      }
      if(event.type==="FILE_GENERATING"){
        const d=event?.data||{};
        addLog("文件",`${d.fileId||"--"} 正在生成...`,"info");
        refreshFilewiseRun();
        return;
      }
      if(event.type==="FILE_REGENERATE_REQUESTED"){
        const d=event?.data||{};
        addLog("文件",`${d.fileId||"--"} 请求重新生成...`,"info");
        refreshFilewiseRun();
        return;
      }
      if(event.type==="FILE_REJECTED"){
        const d=event?.data||{};
        addLog("文件",`${d.fileId||"--"} 已驳回${d.reason?`，原因：${d.reason}`:""}`,"error");
        refreshFilewiseRun();
        return;
      }
      if(event.type==="RUN_POINTER_MOVED"){
        const d=event?.data||{};
        addLog("指针",`stage=${d.stage||"--"} current=${d.currentFile||"--"}`);
        refreshFilewiseRun();
        return;
      }
    }

    function buildTaskLlmConfig() {
      const baseUrl = (document.getElementById("llmBaseUrl").value || "").trim();
      const apiKey = (document.getElementById("llmApiKey").value || "").trim();
      const modelName = (document.getElementById("llmModelName").value || "").trim();
      const cached = getSessionLlmConfig();
      const cfg = {
        baseUrl: baseUrl || cached?.baseUrl || "https://api.deepseek.com",
        apiKey: apiKey || cached?.apiKey || "",
        modelName: modelName || cached?.modelName || "deepseek-chat"
      };
      if (!cfg.apiKey) {
        updateLlmChip(false);
        return null;
      }
      setSessionLlmConfig(cfg);
      updateLlmChip(true);
      return cfg;
    }

    function validateWorkspace(){ const p=(document.getElementById("workspacePath").value||"").trim(); if(!p){ document.getElementById("workspaceStatus").textContent="未设置"; document.getElementById("workspacePathLabel").textContent="output"; setWorkspacePathConfig(""); return; } document.getElementById("workspaceStatus").textContent=`当前目录：${p}`; document.getElementById("workspacePathLabel").textContent=p; setWorkspacePathConfig(p); }
      function saveSettings(){ const llm=buildTaskLlmConfig(); if(!llm){ addLog("错误","保存失败：API Key 不能为空","error"); return; } const mode=(document.getElementById("elicitationMode").value||"quick").trim(); setElicitationMode(mode); const showIntermediate = Boolean(document.getElementById("showIntermediateArtifacts")?.checked); setShowIntermediateArtifacts(showIntermediate); updateLlmChip(true); validateWorkspace(); closeSettings(); if(currentRunState?.files) updateFileTree(currentRunState.files); addLog("系统",`设置已保存（澄清模式：${mode==="deep"?"深度":"快速"}）`,"success"); }

    async function chooseWorkspaceFolder(){ try{ const resp=await fetch(API_BASE+"/api/v1/config/workspace/choose",{method:"POST"}); const data=await resp.json(); if(!resp.ok||!data?.path){ addLog("错误",data?.message||"未选择目录","error"); return; } document.getElementById("workspacePath").value=data.path; validateWorkspace(); addLog("系统",`已选择输出目录：${data.path}`,"success"); }catch(error){ addLog("错误",String(error?.message||error),"error"); } }
    async function testLlmConnection(){ 
      const llm=buildTaskLlmConfig(); 
      const resultDiv = document.getElementById("testConnResult");
      resultDiv.style.display = "block";
      
      if(!llm){ 
        resultDiv.style.color = "var(--red)";
        resultDiv.textContent = "❌ 请先输入 API Key";
        addLog("错误","请先输入 API Key","error"); 
        return; 
      } 
      
      resultDiv.style.color = "var(--muted)";
      resultDiv.textContent = "⏳ 正在测试连接中...";
      
      try{ 
        const resp=await fetch(API_BASE+"/api/v1/config/llm/test",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({llm})
        }); 
        
        if (resp.ok) {
          resultDiv.style.color = "var(--green)";
          resultDiv.textContent = "✅ LLM 连接测试成功";
          addLog("系统", "LLM 连接测试成功", "success");
        } else {
          const errData = await resp.json().catch(()=>({}));
          resultDiv.style.color = "var(--red)";
          resultDiv.textContent = "❌ LLM 连接测试失败: " + (errData.message || resp.statusText || resp.status);
          addLog("系统", "LLM 连接测试失败: " + (errData.message || resp.statusText || resp.status), "error");
        }
      } catch (e) { 
        resultDiv.style.color = "var(--red)";
        resultDiv.textContent = "❌ LLM 连接测试异常: " + (e.message || String(e));
        addLog("错误", "LLM 连接测试异常: " + (e.message || String(e)), "error"); 
      } 
    }

    function normalizeQuestionText(text){
      return String(text||"")
        .toLowerCase()
        .replace(/[\s\r\n\t]+/g,"")
        .replace(/[，。！？、,.!?;；:："'“”‘’（）()【】\[\]{}<>《》\-—_]/g,"");
    }
    function questionSignature(q){
      const options = Array.isArray(q?.options) ? [...q.options].map(normalizeQuestionText).sort().join("|") : "";
      const strict = `${q?.dimension||""}#${q?.questionType||""}#${normalizeQuestionText(q?.questionText||"")}#${options}`;
      const loose = `${q?.dimension||""}#${q?.questionType||""}#${normalizeQuestionText(q?.questionText||"")}`;
      return { strict, loose };
    }
    function mergeQuestions(newQuestions){
      if(!Array.isArray(newQuestions) || newQuestions.length===0) return 0;
      const exists = new Set();
      (activeQuestionnaire||[]).forEach((q)=>{
        const sig = questionSignature(q);
        exists.add(sig.strict);
        exists.add(sig.loose);
      });
      let added = 0;
      newQuestions.forEach((q)=>{
        const sig = questionSignature(q);
        if(!sig.loose || exists.has(sig.strict) || exists.has(sig.loose)) return;
        exists.add(sig.strict);
        exists.add(sig.loose);
        activeQuestionnaire.push(q);
        added++;
      });
      if(clarificationRounds[0]) clarificationRounds[0].questions = activeQuestionnaire;
      return added;
    }

    let elicitationResolve = null;

    function handleElicitationResult(data) {
      if(elicitationResolve) {
        elicitationResolve(data);
        elicitationResolve = null;
      }
    }

    async function requestClarificationRound({requirement,llm,context,workspace,elicitationMode,batchSize,targetTotal,timeoutMs}){
      return new Promise(async (resolve, reject) => {
        elicitationResolve = resolve;
        let timer = null;
        const controller = new AbortController();
        try{
          timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
          const resp=await fetch(API_BASE+"/api/v1/elicitation/questionnaire",{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({requirement,llm,context,workspace,elicitationMode,batchSize,targetTotal}),
            signal:controller.signal
          });
          if(!resp.ok) {
            const rawText = await resp.text();
            let data;
            try{
              data = rawText ? JSON.parse(rawText) : {};
            }catch{
              const head = rawText ? rawText.slice(0, 240) : "";
              elicitationResolve = null;
              reject(new Error(`问卷接口返回非JSON（status=${resp.status}）：${head || resp.statusText}`));
              return;
            }
            elicitationResolve = null;
            reject(new Error(data?.message||`问卷生成失败（status=${resp.status}）`));
          }
        }catch(e){
          elicitationResolve = null;
          reject(e);
        }finally{
          if(timer) clearTimeout(timer);
        }
      });
    }

    async function generateQuestionnaire(){
      const requirement=(document.getElementById("businessGoalInput").value||"").trim();
      if(!requirement){ addLog("错误","请先输入业务目标","error"); return; }
      const llm=buildTaskLlmConfig();
      if(!llm){ addLog("错误","请先在设置中配置 API Key","error"); openSettings(); return; }
      const elicitationMode = getElicitationMode();
      clarificationPlan = null;
      clarificationRounds = [];
      activeQuestionnaire = [];
      finalizedRequirement = requirement;
      questionnaireFullyLoaded = false;
      questionnaireLoading = true;
      backgroundElicitationStop = false;
      Object.keys(answers).forEach((k)=>delete answers[k]);
      Object.keys(customAnswers).forEach((k)=>delete customAnswers[k]);
      if(progressiveAppendTimer){ clearInterval(progressiveAppendTimer); progressiveAppendTimer = null; }
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const workspace=workspacePath ? { path:workspacePath } : (getWorkspacePathConfig()||{});
      const targetTotal = 100;
      const firstBatchSize = elicitationMode==="deep" ? 12 : 6;
      const backgroundBatchSize = elicitationMode==="deep" ? 12 : 8;
      const requestTimeoutMs = elicitationMode==="deep" ? 120000 : 90000;
      openQuestionnaireModal();
      addLog("系统",`AI 正在发起澄清（${elicitationMode==="deep"?"深度":"快速"}模式）...`);
      try{
        const data = await requestClarificationRound({requirement,llm,context:{},workspace,elicitationMode,batchSize:firstBatchSize,targetTotal,timeoutMs:requestTimeoutMs});
        clarificationPlan = data;
        finalizedRequirement = data.refinedRequirement || finalizedRequirement;
        if(data?.meta?.timingMs){
          const t = data.meta.timingMs;
          addLog("系统",`澄清耗时：总 ${t.total}ms，上下文 ${t.context}ms，深度思考 ${t.deepThinking}ms，结构化 ${t.structured}ms`);
        }
        if(data?.meta?.batch?.droppedAsDuplicate>0){
          addLog("系统",`已自动去重 ${data.meta.batch.droppedAsDuplicate} 道重复问题`);
        }
        if(data?.fallback){ addLog("系统","问卷已切换到快速兜底模式，避免长时间阻塞。","success"); }
        const returnedQuestions = data.questionnaire?.questions || [];
        if(data.clarityReached || !Array.isArray(returnedQuestions) || returnedQuestions.length===0){
          questionnaireLoading = false;
          questionnaireFullyLoaded = true;
          closeQuestionnaireModal();
          addLog("系统","AI 判断需求已足够清晰，无需继续提问。","success");
          return;
        }
        activeQuestionnaire = [];
        clarificationRounds = [{ round: 1, questions: activeQuestionnaire }];
        questionIndex=0;
        questionnaireLoading = false;
        mergeQuestions(clone(returnedQuestions));
        renderCurrentQuestion();
        addLog("系统",`首批题目已就绪：${activeQuestionnaire.length}/${targetTotal}`,"success");

        const runBackgroundPrefetch = async ()=>{
          let guard = 0;
          while(!backgroundElicitationStop && activeQuestionnaire.length < targetTotal && guard < 12){
            guard++;
            addLog("系统",`后台补充题库中... 第 ${guard} 批（当前 ${activeQuestionnaire.length}/${targetTotal}）`);
            try{
              const nextData = await requestClarificationRound({
                requirement,
                llm,
                workspace,
                elicitationMode,
                batchSize:backgroundBatchSize,
                targetTotal,
                timeoutMs:requestTimeoutMs,
                context:{
                  refinedRequirement: finalizedRequirement || requirement,
                  previousRounds:[{ round: 1, questions: activeQuestionnaire }],
                  answers: normalizeAnswersForApi()
                }
              });
              finalizedRequirement = nextData?.refinedRequirement || finalizedRequirement;
              const nextQuestions = nextData?.questionnaire?.questions || [];
              const added = mergeQuestions(nextQuestions);
              renderCurrentQuestion();
              if(nextData?.meta?.timingMs){
                const t = nextData.meta.timingMs;
                addLog("系统",`后台批次耗时：总 ${t.total}ms（结构化 ${t.structured}ms）`);
              }
              if(nextData?.meta?.batch?.droppedAsDuplicate>0){
                addLog("系统",`后台批次已去重 ${nextData.meta.batch.droppedAsDuplicate} 道问题`);
              }
              if(added===0 || nextData.clarityReached){
                questionnaireFullyLoaded = true;
                renderCurrentQuestion();
                addLog("系统",`问卷补充完成，共 ${activeQuestionnaire.length} 题。`,"success");
                return;
              }
            }catch(bgErr){
              addLog("系统","后台补题已停止（超时或无新增），不影响当前作答。");
              questionnaireFullyLoaded = true;
              renderCurrentQuestion();
              return;
            }
            await new Promise((r)=>setTimeout(r,150));
          }
          questionnaireFullyLoaded = true;
          renderCurrentQuestion();
          addLog("系统",`问卷补充结束，当前共 ${activeQuestionnaire.length} 题。`,"success");
        };
        void runBackgroundPrefetch();
      }catch(error){
        questionnaireLoading = false;
        const message = String(error?.message||error);
        closeQuestionnaireModal();
        if(message.toLowerCase().includes("aborted")){
          addLog("错误","问卷请求超时，请重试（已启用快速超时保护）","error");
          return;
        }
        addLog("错误",message,"error");
      }
    }

    function openQuestionnaireModal(){ document.getElementById("questionnaireModal").classList.add("show"); renderCurrentQuestion(); }
    function closeQuestionnaireModal(){ backgroundElicitationStop = true; if(progressiveAppendTimer){ clearInterval(progressiveAppendTimer); progressiveAppendTimer = null; } document.getElementById("questionnaireModal").classList.remove("show"); }
    function openFinalizeModal(content){
      finalizeModalOpen = true;
      document.getElementById("finalRequirementEditor").value = content || "";
      document.getElementById("finalizeModal").classList.add("show");
      refreshDesignButtonState();
    }
    function closeFinalizeModal(){
      finalizeModalOpen = false;
      document.getElementById("finalizeModal").classList.remove("show");
      refreshDesignButtonState();
    }
    function openFileReviewModal(){ document.getElementById("fileReviewModal").classList.add("show"); }
    function closeFileReviewModal(){ document.getElementById("fileReviewModal").classList.remove("show"); }

    document.getElementById("filePreview").addEventListener("input", function() {
      filePreviewDirty = true;
      document.getElementById("btnSaveEdit").disabled = false;
    });

    function toggleAutoRun() {
      if(isAutoRunning) {
        isAutoRunning = false;
        addLog("系统", "已停止自动生成");
        renderWorkflowButtons();
      } else {
        if(!currentRunId) { addLog("系统", "当前没有正在运行的任务"); return; }
        isAutoRunning = true;
        addLog("系统", "已开启一键自动生成，将自动跑完前7个文件...");
        renderWorkflowButtons();
        autoRunLoop();
      }
    }

    async function autoRunLoop() {
      while(isAutoRunning && currentRunId && currentRunState) {
        const actions = currentRunState.actions || {};
        if(currentRunState.currentFile === "08") {
          addLog("系统", "前7个文件已完成，自动生成停止在SDD前", "success");
          toggleAutoRun();
          break;
        }
        if(currentRunState.stage === "DONE" || !currentRunState.currentFile) {
          addLog("系统", "自动生成已完成", "success");
          toggleAutoRun();
          break;
        }
        try {
          if(actions.canGenerateNext) {
            await filewiseGenerateNext();
          } else if(actions.canApprove) {
            await filewiseApprove();
          } else {
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch(e) {
          addLog("错误", "自动生成遇到错误，已暂停", "error");
          toggleAutoRun();
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    function getActiveWorkspacePath(){
      const p=(document.getElementById("workspacePath").value||"").trim();
      if(p) return p;
      return getWorkspacePathConfig()?.path || "";
    }
    function getHistoryWorkspacePath(){
      const modalPath = (document.getElementById("historyWorkspacePath").value||"").trim();
      if(modalPath) return modalPath;
      return getActiveWorkspacePath();
    }
    function getSddSourceWorkspacePath(){
      const modalPath = (document.getElementById("sddSourceWorkspacePath").value||"").trim();
      if(modalPath) return modalPath;
      return getActiveWorkspacePath();
    }
    async function chooseHistoryWorkspaceFolder(){
      try{
        const resp=await fetch(API_BASE+"/api/v1/config/workspace/choose",{method:"POST"});
        const data=await resp.json();
        if(!resp.ok||!data?.path){ addLog("错误",data?.message||"未选择目录","error"); return; }
        document.getElementById("historyWorkspacePath").value = data.path;
        await loadHistoryList();
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }
    }
    function openHistoryModal(){
      const currentPath = getActiveWorkspacePath();
      if(currentPath){
        document.getElementById("historyWorkspacePath").value = currentPath;
      }
      document.getElementById("historyModal").classList.add("show");
      void loadHistoryList();
    }
    function closeHistoryModal(){
      document.getElementById("historyModal").classList.remove("show");
    }
    async function chooseSddSourceWorkspaceFolder(){
      try{
        const resp=await fetch(API_BASE+"/api/v1/config/workspace/choose",{method:"POST"});
        const data=await resp.json();
        if(!resp.ok||!data?.path){ addLog("错误",data?.message||"未选择目录","error"); return; }
        document.getElementById("sddSourceWorkspacePath").value = data.path;
        await loadSddSourceRuns();
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }
    }
    function openSddSourceModal(){
      const currentPath = getActiveWorkspacePath();
      if(currentPath){
        document.getElementById("sddSourceWorkspacePath").value = currentPath;
      }
      document.getElementById("sddSourceModal").classList.add("show");
      void loadSddSourceRuns();
    }
    function closeSddSourceModal(){
      document.getElementById("sddSourceModal").classList.remove("show");
    }
    function renderSddSourceRuns(){
      const listEl = document.getElementById("sddSourceList");
      const infoEl = document.getElementById("sddSourceInfo");
      const confirmBtn = document.getElementById("sddSourceConfirmBtn");
      if(!Array.isArray(sddSourceRuns) || sddSourceRuns.length===0){
        listEl.innerHTML = '<div class="history-empty">未找到可用历史流程（需01-07全部审核通过）</div>';
        infoEl.textContent = "未选择历史流程";
        confirmBtn.disabled = true;
        return;
      }
      listEl.innerHTML = sddSourceRuns.map((item)=>{
        const active = selectedSddSourceRunId===item.runId;
        return `<div class="history-item ${active?"active":""}" onclick="selectSddSourceRun('${esc(item.runId)}')"><div style="font-size:13px;font-weight:600;color:#2f4061;">${esc(item.runId)}</div><div class="history-meta">更新时间：${new Date(item.updatedAt).toLocaleString()} · 阶段：${esc(item.stage||"--")}</div><div class="history-summary">状态：${esc(item.status||"--")} · 当前文件：${esc(item.currentFile||"--")}</div></div>`;
      }).join("");
      const selected = sddSourceRuns.find((item)=>item.runId===selectedSddSourceRunId);
      infoEl.textContent = selected ? `已选择：${selected.runId}` : "未选择历史流程";
      confirmBtn.disabled = !selected;
    }
    function selectSddSourceRun(runId){
      selectedSddSourceRunId = runId;
      renderSddSourceRuns();
      renderWorkflowButtons();
      addLog("系统",`已选择历史流程：${runId}`);
    }
    async function loadSddSourceRuns(){
      const workspacePath = getSddSourceWorkspacePath();
      const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
      try{
        const apiPath = currentRunId
          ? `/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/sdd-sources`
          : "/api/v1/tasks/filewise/sdd-sources";
        const resp=await fetch(API_BASE+`${apiPath}${query}`,{ cache:"no-store" });
        const data=await resp.json();
        if(!resp.ok){ addLog("错误",data?.message||"加载SDD历史流程失败","error"); return; }
        sddSourceRuns = Array.isArray(data?.items) ? data.items : [];
        if(selectedSddSourceRunId && !sddSourceRuns.some((item)=>item.runId===selectedSddSourceRunId)){
          selectedSddSourceRunId = null;
        }
        renderSddSourceRuns();
        renderWorkflowButtons();
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }
    }
    function generateSddFromCurrentRun(){
      if(!currentRunId){
        addLog("系统","当前没有任务，请先生成前7文件或选择历史流程");
        return;
      }
      if(currentRunState?.currentFile !== "08"){
        addLog("系统","当前任务未到08阶段，不能直接生成SDD");
        return;
      }
      void filewiseGenerateSdd();
    }
    async function confirmGenerateSddWithSource(){
      if(!selectedSddSourceRunId){ addLog("系统","请先选择历史流程"); return; }
      const btn = document.getElementById("sddSourceConfirmBtn");
      btn.disabled = true;
      closeSddSourceModal();
      addLog("系统",`已开始生成SDD，历史流程=${selectedSddSourceRunId}`);
      try{
    if(currentRunId){
      addLog("系统",`在当前任务 ${currentRunId} 上导入历史1-7并生成SDD...`);
      await filewiseGenerateSdd(selectedSddSourceRunId);
      addLog("系统","SDD生成流程已提交完成","success");
    } else {
      const llm=buildTaskLlmConfig();
      if(!llm){
        addLog("错误","请先在设置中配置 API Key","error");
        openSettings();
        stopSddHeartbeat();
        isGeneratingSdd = false;
        renderWorkflowButtons();
        return;
      }
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      addLog("系统","正在基于历史流程创建任务并生成SDD...");
      isGeneratingSdd = true;
      renderWorkflowButtons();
      startSddHeartbeat();
      
      // 提前绑定当前任务并连接 WS，以便能接收到生成过程中的中间日志
      if(selectedSddSourceRunId !== currentRunId) {
        recentEventLastAt = "";
        recentEventCursor = 0;
      }
      currentRunId = selectedSddSourceRunId;
      currentTaskId = selectedSddSourceRunId;
      setTaskIdentity(currentRunId, selectedSddSourceRunId);
      connectWebSocketForTask(currentRunId);

      const resp=await fetch(API_BASE+"/api/v1/tasks/filewise/generate-sdd-from-source",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          sourceRunId: selectedSddSourceRunId,
          llm,
          workspace: workspacePath ? {path:workspacePath} : undefined
        })
      });
      const data=await resp.json();
      if(!resp.ok){
        addLog("错误",buildSddErrorMessage(data),"error");
        await pullRecentEvents(200);
        stopSddHeartbeat();
        return;
      }
      currentRunState = data;
      recentEventLastAt = data?.lastEventAt || recentEventLastAt;
      await refreshFilewiseRun();
      addLog("系统",`SDD生成完成，任务ID=${currentRunId}`,"success");
    }
  } catch (error) {
        addLog("错误",`SDD生成异常：${String(error?.message||error)}`,"error");
        await pullRecentEvents(200);
        stopSddHeartbeat();
      } finally {
        btn.disabled = false;
        isGeneratingSdd = false;
        renderWorkflowButtons();
      }
    }
    function renderHistoryList(){
      const container=document.getElementById("historyList");
      if(!Array.isArray(historyRecords) || historyRecords.length===0){
        container.innerHTML='<div class="history-empty">未找到历史任务</div>';
        return;
      }
      container.innerHTML=historyRecords.map((item)=>{
        const active = selectedHistory && selectedHistory.id===item.id && selectedHistory.type===item.type;
        const typeText = item.type==="draft" ? "draft" : "task";
        const disabledText = item.requirementAvailable ? "" : " · 缺少需求文件";
        return `<div class="history-item ${active?"active":""}" onclick="selectHistory('${esc(item.id)}','${esc(item.type)}')"><div style="font-size:13px;font-weight:600;color:#2f4061;">${esc(item.id)}</div><div class="history-meta">${typeText} · ${new Date(item.createdAt).toLocaleString()}${disabledText}</div><div class="history-summary">${esc(item.summary||"(无摘要)")}</div></div>`;
      }).join("");
    }
    function renderHistoryTabs(){
      const tabs = ["final","normalized","raw"];
      document.getElementById("historyTabs").innerHTML = tabs.map((key)=>{
        const active = selectedHistoryPreviewKey===key ? "active" : "";
        return `<button class="history-tab ${active}" onclick="switchHistoryPreview('${key}')">${key}</button>`;
      }).join("");
    }
    function switchHistoryPreview(key){
      selectedHistoryPreviewKey = key;
      renderHistoryTabs();
      renderHistoryPreview();
    }
    function renderHistoryPreview(){
      const previewEl=document.getElementById("historyPreview");
      const infoEl=document.getElementById("historySelectionInfo");
      const continueBtn=document.getElementById("historyContinueBtn");
      if(!selectedHistoryDetail){
        previewEl.textContent = "请选择左侧历史任务";
        infoEl.textContent = "未选择历史任务";
        continueBtn.disabled = true;
        return;
      }
      const previews = selectedHistoryDetail.previews || {};
      const current = previews[selectedHistoryPreviewKey] || {};
      const content = current.exists ? (current.content || "") : "该文件不存在";
      const truncated = current.truncated ? "\n\n[预览已截断]" : "";
      previewEl.textContent = content + truncated;
      const src = selectedHistoryDetail.id || "--";
      const req = selectedHistoryDetail.requirement || {};
      infoEl.textContent = `来源任务ID: ${src} | 需求源: ${req.source || "--"} | 工作目录: ${getHistoryWorkspacePath() || "--"}`;
      continueBtn.disabled = !req.available;
    }
    async function loadHistoryList(){
      const workspacePath = getHistoryWorkspacePath();
      const queryParts = [];
      if(workspacePath) queryParts.push(`workspacePath=${encodeURIComponent(workspacePath)}`);
      queryParts.push(`_ts=${Date.now()}`);
      const query = `?${queryParts.join("&")}`;
      try{
        const resp=await fetch(API_BASE+`/api/v1/history/requirements${query}`,{ cache:"no-store" });
        const data=await resp.json();
        if(!resp.ok){
          historyRecords = [];
          selectedHistory = null;
          selectedHistoryDetail = null;
          renderHistoryList();
          renderHistoryTabs();
          renderHistoryPreview();
          addLog("错误",data?.message||"读取历史任务失败","error");
          return;
        }
        if(data?.workspacePath){
          document.getElementById("historyWorkspacePath").value = data.workspacePath;
        }
        historyRecords = Array.isArray(data?.items)
          ? data.items.filter((item)=>item?.requirementAvailable)
          : [];
        selectedHistory = null;
        selectedHistoryDetail = null;
        selectedHistoryPreviewKey = "final";
        renderHistoryList();
        renderHistoryTabs();
        renderHistoryPreview();
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }
    }
    async function selectHistory(id,type){
      selectedHistory = { id, type };
      renderHistoryList();
      const workspacePath = getHistoryWorkspacePath();
      const queryParts = [];
      if(type) queryParts.push(`type=${encodeURIComponent(type)}`);
      if(workspacePath) queryParts.push(`workspacePath=${encodeURIComponent(workspacePath)}`);
      queryParts.push(`_ts=${Date.now()}`);
      const query = queryParts.length>0 ? `?${queryParts.join("&")}` : "";
      try{
        const resp=await fetch(API_BASE+`/api/v1/history/requirements/${encodeURIComponent(id)}${query}`,{ cache:"no-store" });
        const data=await resp.json();
        if(!resp.ok){ addLog("错误",data?.message||"读取历史详情失败","error"); return; }
        selectedHistoryDetail = data;
        const reqSource = data?.requirement?.source || "final";
        selectedHistoryPreviewKey = reqSource;
        renderHistoryTabs();
        renderHistoryPreview();
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }
    }
    async function continueFromHistory(){
      if(!selectedHistoryDetail || !selectedHistoryDetail.requirement?.available){
        addLog("错误","历史任务缺少可用需求文件，无法继续生成","error");
        return;
      }
      const llm=buildTaskLlmConfig();
      if(!llm){ addLog("错误","请先在设置中配置 API Key","error"); openSettings(); return; }
      const workspacePath = getHistoryWorkspacePath();
      const workspace = workspacePath ? { path: workspacePath } : (getWorkspacePathConfig()||{});
      try{
        const reqSource = selectedHistoryDetail?.requirement?.source || "final";
        const requirement = String(selectedHistoryDetail?.previews?.[reqSource]?.content || "").trim();
        if(!requirement){ addLog("错误","历史需求内容为空","error"); return; }
        const resp=await fetch(API_BASE+"/api/v1/tasks/filewise/start",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({ requirement, llm, workspace })
        });
        const data=await resp.json();
        if(!resp.ok){ addLog("错误",data?.message||"从历史任务继续生成失败","error"); return; }
        if(data.runId !== currentRunId) {
          recentEventLastAt = "";
          recentEventCursor = 0;
        }
        currentRunId = data.runId;
        currentTaskId = data.runId;
        setTaskIdentity(currentRunId, selectedHistoryDetail.id || "--");
        connectWebSocketForTask(currentRunId);
        await refreshFilewiseRun();
        addLog("系统",`新任务ID：${currentRunId}，来源任务ID：${selectedHistoryDetail.id}`,"success");
        closeHistoryModal();
        refreshDesignButtonState();
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }
    }

    function renderCurrentQuestion(){
      const qs=activeQuestionnaire||[];
      if(questionnaireLoading){
        document.getElementById("questionProgress").textContent="正在生成问卷...";
        document.getElementById("questionTitle").textContent="正在准备澄清问题，请稍候";
        document.getElementById("questionDimension").textContent="系统正在读取项目上下文并生成问题";
        document.getElementById("questionType").textContent="";
        document.getElementById("questionOptions").innerHTML='<div style="font-size:13px;color:var(--muted);line-height:1.8;">已启动后台思考流程，题目将分批加载到窗口。</div>';
        document.getElementById("prevQuestionBtn").style.display="none";
        document.getElementById("nextQuestionBtn").style.display="none";
        document.getElementById("finishQuestionBtn").style.display="none";
        return;
      }
      if(qs.length===0){
        document.getElementById("questionProgress").textContent="正在加载题目...";
        document.getElementById("questionTitle").textContent="请稍候";
        document.getElementById("questionDimension").textContent="";
        document.getElementById("questionType").textContent="";
        document.getElementById("questionOptions").innerHTML='<div style="font-size:13px;color:var(--muted);">题目将很快显示。</div>';
        document.getElementById("prevQuestionBtn").style.display="none";
        document.getElementById("nextQuestionBtn").style.display="none";
        document.getElementById("finishQuestionBtn").style.display="none";
        return;
      }
      const q=qs[questionIndex];
      document.getElementById("questionProgress").textContent=`第 ${questionIndex+1} / ${qs.length} 题`;
      document.getElementById("questionTitle").textContent=q.questionText;
      document.getElementById("questionDimension").textContent=`维度：${q.dimension}`;
      const type = q.questionType === "multiple" ? "multiple" : "single";
      document.getElementById("questionType").textContent = `题型：${type==="multiple"?"多选":"单选"}`;
      if(type==="single" && typeof answers[q.id] !== "string"){ answers[q.id]=q.options[0]; }
      if(type==="multiple" && !Array.isArray(answers[q.id])){ answers[q.id]=[]; }
      const selectedSingle = typeof answers[q.id] === "string" ? answers[q.id] : q.options[0];
      const selectedMulti = Array.isArray(answers[q.id]) ? answers[q.id] : [];
      const customList = customAnswers[q.id] || [];
      const optionsHtml=q.options.map((opt)=>{
        const escapedQid = q.id.replace(/'/g,"\\'");
        const escapedOpt = opt.replace(/'/g,"\\'");
        if(type==="multiple"){
          return `<label class="q-option"><input type="checkbox" name="modal_q_${q.id}" value="${esc(opt)}" ${selectedMulti.includes(opt)?"checked":""} onchange="toggleModalAnswer('${escapedQid}','${escapedOpt}',this.checked)"/> <span>${esc(opt)}</span></label>`;
        }
        return `<label class="q-option"><input type="radio" name="modal_q_${q.id}" value="${esc(opt)}" ${selectedSingle===opt?"checked":""} onchange="setModalAnswer('${escapedQid}','${escapedOpt}')"/> <span>${esc(opt)}</span></label>`;
      }).join("");
      const escapedQid = q.id.replace(/'/g,"\\'");
      const customListHtml = customList.map((item)=>{
        const escapedItem = String(item).replace(/'/g,"\\'");
        return `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;"><span style="font-size:12px;padding:2px 8px;border:1px solid var(--line2);border-radius:999px;color:#4f5f7d;background:#f8fbff;">${esc(item)}</span><button class="btn btn-light" style="padding:4px 8px;font-size:12px;" onclick="removeCustomAnswer('${escapedQid}','${escapedItem}')">移除</button></div>`;
      }).join("");
      const customAnswerHtml = `
        <div style="margin-top:10px;border-top:1px dashed var(--line2);padding-top:10px;">
          <div style="font-size:13px;color:#5f6f8e;margin-bottom:6px;">自定义补充（可添加多条，作为 AI 选项的补充）</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="customInput_${q.id}" class="field" style="padding:8px 10px;" placeholder="请输入补充答案" value="" />
            <button class="btn btn-light" onclick="applyCustomAnswer('${escapedQid}')">添加</button>
          </div>
          ${customListHtml}
        </div>
      `;
      document.getElementById("questionOptions").innerHTML=optionsHtml + customAnswerHtml;
      document.getElementById("prevQuestionBtn").style.display="inline-block";
      document.getElementById("prevQuestionBtn").disabled=questionIndex===0;
      const isLast=questionIndex===qs.length-1;
      document.getElementById("nextQuestionBtn").style.display=isLast?"none":"inline-block";
      const finishBtn = document.getElementById("finishQuestionBtn");
      if(isLast){
        finishBtn.style.display="inline-block";
        if(questionnaireFullyLoaded){
          finishBtn.disabled=false;
          finishBtn.textContent="完成问卷";
        }else{
          finishBtn.disabled=true;
          finishBtn.textContent="后台补题中...";
        }
      }else{
        finishBtn.style.display="none";
        finishBtn.disabled=false;
        finishBtn.textContent="完成问卷";
      }

      // 始终显示一个强行中断的次级按钮
      const forceFinishBtn = document.getElementById("forceFinishBtn");
      if(!forceFinishBtn) {
        const btn = document.createElement("button");
        btn.id = "forceFinishBtn";
        btn.className = "btn btn-light";
        btn.style.color = "#d85555";
        btn.style.borderColor = "#f1c3c3";
        btn.textContent = "结束澄清并生成需求";
        btn.onclick = () => finishQuestionnaire(true);
        document.querySelector("#questionnaireModal .modal-ft").prepend(btn);
      }
    }

    function scheduleBackgroundFinalize(reason){
      if(finalizeDebounceTimer){ clearTimeout(finalizeDebounceTimer); finalizeDebounceTimer = null; }
      finalizeDebounceTimer = setTimeout(()=>{
        void runBackgroundFinalize(reason);
      }, 1200);
    }
    async function runBackgroundFinalize(reason){
      if(backgroundFinalizeRunning){
        backgroundFinalizePending = true;
        return;
      }
      const requirement=(document.getElementById("businessGoalInput").value||"").trim();
      const llm=buildTaskLlmConfig();
      if(!requirement || !llm) return;
      backgroundFinalizeRunning = true;
      const seq = ++backgroundFinalizeSeq;
      const currentFingerprint = buildAnswersFingerprint();
      try{
        const finalData = await finalizeRequirementInternal(requirement,llm,{persistDraft:false});
        if(seq !== backgroundFinalizeSeq) return;
        finalizedRequirement = finalData.finalRequirement || finalizedRequirement || requirement;
        lastFinalizedFingerprint = currentFingerprint;
        lastFinalizedAt = Date.now();
      }catch(_err){
      }finally{
        backgroundFinalizeRunning = false;
        if(backgroundFinalizePending){
          backgroundFinalizePending = false;
          void runBackgroundFinalize("pending");
        }
      }
    }
    function setModalAnswer(qid,opt){ answers[qid]=opt; scheduleBackgroundFinalize("single"); }
    function toggleModalAnswer(qid,opt,checked){
      if(!Array.isArray(answers[qid])) answers[qid]=[];
      const next = new Set(answers[qid]);
      if(checked) next.add(opt);
      else next.delete(opt);
      answers[qid]=Array.from(next);
      scheduleBackgroundFinalize("multiple");
    }
    function applyCustomAnswer(qid){
      const input=document.getElementById(`customInput_${qid}`);
      const value=(input?.value||"").trim();
      if(!value){ addLog("系统","请输入自定义答案后再提交。"); return; }
      if(!customAnswers[qid]) customAnswers[qid]=[];
      if(!customAnswers[qid].includes(value)) customAnswers[qid].push(value);
      input.value="";
      scheduleBackgroundFinalize("custom-add");
      renderCurrentQuestion();
    }
    function removeCustomAnswer(qid,value){
      if(!customAnswers[qid]) return;
      customAnswers[qid]=customAnswers[qid].filter((item)=>item!==value);
      scheduleBackgroundFinalize("custom-remove");
      renderCurrentQuestion();
    }
    function prevQuestion(){ if(questionIndex>0){ questionIndex--; renderCurrentQuestion(); } }
    function nextQuestion(){
      const qs=activeQuestionnaire||[];
      if(questionIndex<qs.length-1){
        questionIndex++;
        renderCurrentQuestion();
        return;
      }
      if(!questionnaireFullyLoaded){
        addLog("系统","题库仍在后台加载中，请稍候几秒。");
      }
    }

    async function finalizeRequirementInternal(requirement,llm,options={}){
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const workspace=workspacePath ? { path:workspacePath } : (getWorkspacePathConfig()||{});
      const persistDraft = options.persistDraft !== false;
      const resp=await fetch(API_BASE+"/api/v1/elicitation/finalize",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          requirement,
          questionnaire: { questions: getFlattenQuestionnaire() },
          answers:normalizeAnswersForApi(),
          persistDraft,
          llm,
          workspace
        })
      });
      const data=await resp.json();
      if(!resp.ok) throw new Error(data?.message||"需求定稿失败");
      return data;
    }
    function logFinalizeMeta(data){
      const meta = data?.meta || {};
      addLog("系统","========== 定稿阶段执行信息 ==========");
      addLog("系统",`PRD MCP 可用: ${meta.prdMcpAvailable ? "是" : "否"}`);
      addLog("系统",`PRD MCP 尝试调用: ${meta.prdMcpAttempted ? "是" : "否"}`);
      addLog("系统",`PRD MCP 命中工具: ${meta.prdDraftToolName || "(无)"}`);
      if(Array.isArray(meta.availableTools)){
        addLog("系统",`当前 MCP 可用工具: ${meta.availableTools.join(", ") || "(空)"}`);
      }
      if(meta.prdDraftEnabled){
        addLog("系统","本次定稿已吸收 PRD MCP 草案。","success");
      }else{
        addLog("系统",`PRD MCP 未命中，已回退本地定稿逻辑。原因：${meta.prdMcpReason || "未提供"}`,"error");
      }
      if(meta?.prdMcpDiagnosis){
        const d = meta.prdMcpDiagnosis;
        addLog("系统",`MCP 诊断: ${d.hint || "无"}`);
        addLog("系统",`诊断标记 => 未安装:${d.likelyNotInstalled ? "是":"否"} 网络问题:${d.likelyNetworkOrRegistry ? "是":"否"} 运行异常:${d.likelyRuntimeFailure ? "是":"否"}`);
      }
      if(meta?.draftFiles){
        const f = meta.draftFiles;
        addLog("系统",`中间文件(runId=${f.runId || "unknown"})`);
        addLog("系统",`- status: ${f.statusPath}`);
        addLog("系统",`- raw: ${f.rawPath}`);
        addLog("系统",`- normalized: ${f.normalizedPath}`);
        addLog("系统",`- finalize_input: ${f.inputPath}`);
        addLog("系统",`- fused_final: ${f.finalPath}`);
      }
      addLog("系统","=====================================");
    }

    async function regenerateFinalRequirement(){
      const requirement=(document.getElementById("businessGoalInput").value||"").trim();
      const llm=buildTaskLlmConfig();
      if(!llm){ addLog("错误","请先配置 API Key","error"); return; }
      addLog("系统","正在重新生成定稿...");
      try{
        const finalData = await finalizeRequirementInternal(requirement,llm,{persistDraft:true});
        finalizedRequirement = finalData.finalRequirement || finalizedRequirement || requirement;
        document.getElementById("finalRequirementEditor").value = finalizedRequirement;
        logFinalizeMeta(finalData);
        lastFinalizedFingerprint = buildAnswersFingerprint();
        lastFinalizedAt = Date.now();
        addLog("系统","定稿已重新生成。","success");
        refreshDesignButtonState();
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }
    }
    function confirmFinalRequirement(){
      const text = (document.getElementById("finalRequirementEditor").value||"").trim();
      if(!text){ addLog("错误","定稿内容不能为空","error"); return; }
      finalizedRequirement = text;
      lastFinalizedFingerprint = buildAnswersFingerprint();
      lastFinalizedAt = Date.now();
      closeFinalizeModal();
      addLog("系统","定稿已确认，可直接启动设计生成。","success");
      refreshDesignButtonState();
    }

    async function finishQuestionnaire(force = false){
      const requirement=(document.getElementById("businessGoalInput").value||"").trim();
      const llm=buildTaskLlmConfig();
      if(!llm){ addLog("错误","请先配置 API Key","error"); return; }
      if(!force && !questionnaireFullyLoaded){
        addLog("系统","题库仍在后台补充，请稍候后再完成问卷。");
        renderCurrentQuestion();
        return;
      }
      backgroundElicitationStop = true;
      closeQuestionnaireModal();
      if(finalizeDebounceTimer){ clearTimeout(finalizeDebounceTimer); finalizeDebounceTimer = null; }
      const latestFingerprint = buildAnswersFingerprint();
      const canReuseFinalized = finalizedRequirement && latestFingerprint === lastFinalizedFingerprint && (Date.now() - lastFinalizedAt < 15000);
      if(canReuseFinalized){
        openFinalizeModal(finalizedRequirement);
        addLog("系统","需求已在作答过程中实时定稿完成，请确认或编辑后继续。","success");
        return;
      }
      finalizeInProgress = true;
      refreshDesignButtonState();
      addLog("系统","正在补齐最后一次定稿同步...");
      try{
        if(backgroundFinalizeRunning){
          const waitStart = Date.now();
          while(backgroundFinalizeRunning && Date.now() - waitStart < 15000){
            await new Promise((r)=>setTimeout(r,150));
          }
        }
        const finalData = await finalizeRequirementInternal(requirement,llm,{persistDraft:true});
        finalizedRequirement = finalData.finalRequirement || finalizedRequirement || requirement;
        logFinalizeMeta(finalData);
        lastFinalizedFingerprint = latestFingerprint;
        lastFinalizedAt = Date.now();
        openFinalizeModal(finalizedRequirement);
        addLog("系统","需求定稿完成，请确认或编辑后继续。","success");
      }catch(error){
        addLog("错误",String(error?.message||error),"error");
      }finally{
        finalizeInProgress = false;
        refreshDesignButtonState();
      }
    }

    function mapFilewiseStageToUi(stage){
      if(stage==="MODELING") return "SOLUTION_DESIGN";
      if(stage==="REVIEW") return "QUALITY_REVIEW";
      if(stage==="DETAILING") return "IMPLEMENTATION_BLUEPRINT";
      if(stage==="DONE") return "DONE";
      return "STANDBY";
    }
    async function selectPipelineFile(fileId){
      selectedFileId = fileId;
      updateFileTree(currentRunState?.files || []);
      
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
      try {
        const resp = await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/files/${encodeURIComponent(fileId)}/content${query}`,{ cache:"no-store" });
        if(resp.ok) {
          const data = await resp.json();
          if (!filePreviewDirty) {
            document.getElementById("filePreview").value = data.content || "";
          }
        }
      } catch (e) {
        console.error("Failed to load file content", e);
      }

      if(currentRunState?.currentFile===fileId){
        const currentFileRec = currentRunState?.files?.find(f => f.fileId === fileId);
        if(currentFileRec && (currentFileRec.status === "GENERATED" || currentFileRec.status === "REVIEWING" || currentFileRec.status === "REJECTED")) {
          openFileReviewModal();
        }
      }
    }
    async function _doRefreshFilewiseRun(){
      if(!currentRunId) return;
      if(refreshInFlight){
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      try{
        do{
          refreshQueued = false;
          const workspacePath=(document.getElementById("workspacePath").value||"").trim();
          const query = workspacePath ? `?workspace=${encodeURIComponent(workspacePath)}` : "";
          const resp=await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}${query}`,{ cache:"no-store" });
          const data=await resp.json();
          if(!resp.ok){
            addLog("错误",data?.message||"读取流水线状态失败","error");
            renderWorkflowButtons();
            return;
          }
          currentRunState = data;
          currentTaskId = data.runId;
          setTaskIdentity(data.runId, document.getElementById("sourceTaskId").textContent || "--");
          activateState(mapFilewiseStageToUi(data.stage));
          updateFileTree(data.files || []);
          if (data?.sdd?.validation && data.sdd.validation.passed === false) {
            const conflicts = Array.isArray(data.sdd.validation.conflicts) ? data.sdd.validation.conflicts : [];
            const head = conflicts.slice(0, 3).map((c) => `${c.message || ""}${c.location ? ` @${c.location}` : ""}`).filter(Boolean).join("；");
            const action = conflicts.slice(0, 3).map((c) => c.suggestion).filter(Boolean).join("；");
            const gateLogKey = `${data.runId || ""}|${head}|${action}`;
            if (lastSddGateLogKey !== gateLogKey) {
              addLog("SDD Gate", `未通过：${head || "存在一致性冲突"} | 建议：${action || "先修正01-07后重试"}`, "error");
              lastSddGateLogKey = gateLogKey;
            }
          } else {
            lastSddGateLogKey = "";
          }
          if(data.currentFile){
            document.getElementById("previewName").textContent = data.currentFile;
            
            const currentFileRec = data.files.find(f => f.fileId === data.currentFile);
            const needsReview = currentFileRec && (currentFileRec.status === "GENERATED" || currentFileRec.status === "REVIEWING" || currentFileRec.status === "REJECTED");
            
            if (data.currentFileContent !== undefined) {
              if (!filePreviewDirty) {
                document.getElementById("filePreview").value = data.currentFileContent || "";
              }
              if (needsReview && !isAutoRunning) {
                openFileReviewModal();
              } else if (!needsReview) {
                closeFileReviewModal();
              }
            } else {
              // No content provided in summary response. Fetch if we are switching to it, or if we need to review it.
              if (selectedFileId !== data.currentFile || (needsReview && !isAutoRunning && document.getElementById("filePreview").value === "")) {
                await selectPipelineFile(data.currentFile);
              } else {
                if (needsReview && !isAutoRunning) {
                  openFileReviewModal();
                } else if (!needsReview) {
                  closeFileReviewModal();
                }
              }
            }
          }else{
            document.getElementById("filePreview").value = "";
            closeFileReviewModal();
          }
          document.getElementById("workspaceStatus").textContent=`当前目录：${data.workspacePath || workspacePath || "output"}`;
          document.getElementById("workspacePathLabel").textContent=data.workspacePath || workspacePath || "output";
          if(data.stage === "DONE" || data.status === "DONE"){
            stopSddHeartbeat();
          }
          renderWorkflowButtons();
        } while(refreshQueued);
      } finally {
        refreshInFlight = false;
      }
    }

    function refreshFilewiseRun() {
      if (refreshDebounceTimer) {
        clearTimeout(refreshDebounceTimer);
      }
      refreshDebounceTimer = setTimeout(() => {
        _doRefreshFilewiseRun();
      }, 500);
    }
    async function filewiseGenerateBaseNext(){
      if(!currentRunId){ addLog("系统","当前不是 filewise 任务"); return; }
      isGeneratingBase = true;
      renderWorkflowButtons();
      try{
        const workspacePath=(document.getElementById("workspacePath").value||"").trim();
        const resp=await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/generate-base-next`,{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({workspace: workspacePath ? {path:workspacePath} : undefined})
        });
        const data=await resp.json();
        if(!resp.ok){
          const fileId=data?.currentFile;
          const detail=Array.isArray(data?.files) && fileId ? (data.files.find((f)=>f.fileId===fileId)?.lastError || "") : "";
          addLog("错误",[data?.message||"生成失败",detail].filter(Boolean).join(" | "),"error");
          return;
        }
        currentRunState = data;
        await refreshFilewiseRun();
      } finally {
        isGeneratingBase = false;
        renderWorkflowButtons();
      }
    }
    async function filewiseGenerateSdd(sourceRunId){
      if(!currentRunId){ addLog("系统","当前不是 filewise 任务"); return; }
      const llm = buildTaskLlmConfig();
      if(!llm){ 
        addLog("错误","请先在设置中配置 API Key","error"); 
        openSettings(); 
        return; 
      }
      isGeneratingSdd = true;
      renderWorkflowButtons();
      startSddHeartbeat();
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      addLog("系统","正在生成SDD...");
      
      try {
        const resp=await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/generate-sdd`,{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            sourceRunId: sourceRunId || undefined,
            workspace: workspacePath ? {path:workspacePath} : undefined
          })
        });
        const data=await resp.json();
        if(!resp.ok){
          addLog("错误",buildSddErrorMessage(data),"error");
          await pullRecentEvents(200);
          stopSddHeartbeat();
          return;
        }
        if(data?.runId){
          if(data.runId !== currentRunId) {
            recentEventLastAt = "";
            recentEventCursor = 0;
          }
          currentRunId = data.runId;
          currentTaskId = data.runId;
          setTaskIdentity(currentRunId, sourceRunId || document.getElementById("sourceTaskId").textContent || "--");
          connectWebSocketForTask(currentRunId);
        }
        currentRunState = data;
        await refreshFilewiseRun();
      } catch (err) {
        addLog("错误","生成SDD请求异常: " + String(err?.message || err), "error");
        stopSddHeartbeat();
      } finally {
        isGeneratingSdd = false;
        renderWorkflowButtons();
      }
    }
    async function filewiseGenerateNext(){
      if(currentRunState?.currentFile === "08"){
        await filewiseGenerateSdd();
        return;
      }
      await filewiseGenerateBaseNext();
    }
    async function filewiseApprove(){
      if(!currentRunId || !currentRunState?.currentFile){ return; }
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const fileId = currentRunState.currentFile;
      const resp=await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/files/${encodeURIComponent(fileId)}/approve`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({workspace: workspacePath ? {path:workspacePath} : undefined})
      });
      const data=await resp.json();
      if(!resp.ok){ addLog("错误",data?.message||"通过失败","error"); return; }
      currentRunState = data;
      await refreshFilewiseRun();
    }
    async function filewiseReject(){
      if(!currentRunId || !currentRunState?.currentFile){ return; }
      const reason=(document.getElementById("fileRejectReason").value||"").trim();
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const fileId = currentRunState.currentFile;
      const resp=await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/files/${encodeURIComponent(fileId)}/reject`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({reason,workspace: workspacePath ? {path:workspacePath} : undefined})
      });
      const data=await resp.json();
      if(!resp.ok){ addLog("错误",data?.message||"驳回失败","error"); return; }
      currentRunState = data;
      await refreshFilewiseRun();
    }
    async function filewiseRegenerate(){
      if(!currentRunId || !currentRunState?.currentFile){ return; }
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const fileId = currentRunState.currentFile;
      const resp=await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/files/${encodeURIComponent(fileId)}/regenerate`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({workspace: workspacePath ? {path:workspacePath} : undefined})
      });
      const data=await resp.json();
      if(!resp.ok){
        const fileId=data?.currentFile;
        const detail=Array.isArray(data?.files) && fileId ? (data.files.find((f)=>f.fileId===fileId)?.lastError || "") : "";
        addLog("错误",[data?.message||"重生成失败",detail].filter(Boolean).join(" | "),"error");
        return;
      }
      currentRunState = data;
      await refreshFilewiseRun();
    }
    async function filewiseSaveEdit(){
      if(!currentRunId || !currentRunState?.currentFile){ return; }
      const content = document.getElementById("filePreview").value || "";
      if(!content.trim()){
        addLog("错误","当前编辑区为空，先生成文件或输入内容后再保存","error");
        updateFileActionButtons();
        return;
      }
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const fileId = currentRunState.currentFile;
      const resp=await fetch(API_BASE+`/api/v1/tasks/filewise/${encodeURIComponent(currentRunId)}/files/${encodeURIComponent(fileId)}/save-edit`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({content,workspace: workspacePath ? {path:workspacePath} : undefined})
      });
      const data=await resp.json();
      if(!resp.ok){ addLog("错误",data?.message||"保存失败","error"); return; }
      currentRunState = data;
      addLog("系统",`文件 ${fileId} 修改已保存`,"success");
      filePreviewDirty = false;
      await refreshFilewiseRun();
    }
    async function startDesignOnly(){
      let requirement=(finalizedRequirement||"").trim();
      if(!requirement){ requirement=(document.getElementById("businessGoalInput").value||"").trim(); }
      if(!requirement){ addLog("错误","请先输入业务目标并完成澄清","error"); return; }
      if(finalizeInProgress){ addLog("系统","需求定稿仍在后台处理中，请稍候..."); return; }
      if(finalizeModalOpen){ addLog("系统","请先在定稿窗口中确认需求。"); return; }
      const llm=buildTaskLlmConfig(); if(!llm){ addLog("错误","请先在设置中配置 API Key","error"); openSettings(); return; }
      const workspacePath=(document.getElementById("workspacePath").value||"").trim();
      const workspace=workspacePath ? { path:workspacePath } : (getWorkspacePathConfig()||{});
      designSubmitting = true;
      refreshDesignButtonState();
      addLog("系统","正在提交设计任务...");
      try{
        const payload = {
          requirement,
          llm,
          workspace,
          questionnaire: { questions: getFlattenQuestionnaire() },
          userAnswers:normalizeAnswersForApi()
        };
        const resp=await fetch(API_BASE+"/api/v1/tasks/filewise/start",{
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify(payload)
        });
        const data=await resp.json();
        if(!resp.ok){ addLog("错误",data?.message||"任务提交失败","error"); return; }
        if(data.runId !== currentRunId) {
          recentEventLastAt = "";
          recentEventCursor = 0;
        }
        currentRunId = data.runId;
        currentTaskId = data.runId;
        currentRunState = null;
        selectedFileId = null;
        setTaskIdentity(currentRunId, "--");
        connectWebSocketForTask(currentRunId);
        await refreshFilewiseRun();
        addLog("系统",`任务创建成功：${currentRunId}`,"success");
      }catch(error){ addLog("错误",String(error?.message||error),"error"); }
      finally { designSubmitting = false; refreshDesignButtonState(); }
    }

    async function loadSettings(){
      try{ const resp=await fetch(API_BASE+"/api/v1/config"); if(resp.ok){ const conf=await resp.json(); document.getElementById("llmBaseUrl").value=conf?.llm?.baseUrl||"https://api.deepseek.com"; document.getElementById("llmModelName").value=conf?.llm?.modelName||"deepseek-chat"; document.getElementById("workspacePath").value=conf?.workspace?.path||"output"; } } catch {}
      const llm=getSessionLlmConfig();
      if(llm){ document.getElementById("llmBaseUrl").value=llm.baseUrl||""; document.getElementById("llmApiKey").value=llm.apiKey||""; document.getElementById("llmModelName").value=llm.modelName||""; }
      document.getElementById("elicitationMode").value=getElicitationMode();

      updateLlmChip(Boolean(llm&&llm.apiKey));
      const w=getWorkspacePathConfig(); if(w?.path){ document.getElementById("workspacePath").value=w.path; }
      validateWorkspace();
      refreshDesignButtonState();
    }

    document.addEventListener("DOMContentLoaded",()=>{
      document.getElementById("businessGoalInput").addEventListener("input", refreshDesignButtonState);
      document.getElementById("llmApiKey").addEventListener("input", () => {
        refreshDesignButtonState();
        updateLlmChip(document.getElementById("llmApiKey").value.trim().length > 0);
      });
      document.getElementById("llmBaseUrl").addEventListener("input", refreshDesignButtonState);
      document.getElementById("llmModelName").addEventListener("input", refreshDesignButtonState);
      document.getElementById("filePreview").addEventListener("input", updateFileActionButtons);

      // 针对浏览器按需自动填充（Autofill on interaction）的检测机制
      const checkAutofill = () => {
        const apiKeyInput = document.getElementById("llmApiKey");
        if (apiKeyInput && apiKeyInput.value.trim().length > 0) {
          updateLlmChip(true);
          refreshDesignButtonState();
          return true;
        }
        return false;
      };
      
      // 初始轮询 2 秒 (应对立即填充的浏览器)
      let autofillCheckCount = 0;
      const autofillInterval = setInterval(() => {
        if (checkAutofill() || ++autofillCheckCount > 4) clearInterval(autofillInterval);
      }, 500);

      // 监听用户首次交互 (应对 Chrome 交互后才填充的安全机制)
      const interactionEvents = ['click', 'focusin', 'keydown', 'mousemove'];
      const onInteract = () => {
        if (checkAutofill()) {
          interactionEvents.forEach(e => document.removeEventListener(e, onInteract));
        }
      };
      interactionEvents.forEach(e => document.addEventListener(e, onInteract, { passive: true }));

      loadSettings();
      setTaskIdentity("--","--");
      connectWebSocket(null);
      activateState("STANDBY");
      renderWorkflowButtons();
      refreshDesignButtonState();
      addLog("系统","界面已就绪：先点 AI 澄清，再生成设计套件");
    });
