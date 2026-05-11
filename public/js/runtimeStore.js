export const API_BASE = "";
export const SESSION_LLM_CONFIG_KEY = "jap.llm.session.config";
export const LOCAL_WORKSPACE_PATH_KEY = "jap.workspace.path";
export const SESSION_ELICITATION_MODE_KEY = "jap.elicitation.mode";
export const LOCAL_WORKFLOW_MODE_KEY = "jap.workflow.mode";
export const LOCAL_SHOW_INTERMEDIATE_ARTIFACTS_KEY = "jap.ui.showIntermediateArtifacts";
export const STATE_ORDER = ["STANDBY", "DISCOVERY", "SOLUTION_DESIGN", "QUALITY_REVIEW", "IMPLEMENTATION_BLUEPRINT", "DELIVERY_RELEASE", "DONE", "ERROR"];
export const STATE_LABEL_MAP = {
  STANDBY: "待命",
  DISCOVERY: "需求澄清",
  SOLUTION_DESIGN: "方案建模",
  QUALITY_REVIEW: "质量审阅",
  IMPLEMENTATION_BLUEPRINT: "实施蓝图",
  DELIVERY_RELEASE: "交付发布",
  DONE: "已完成",
  ERROR: "异常",
};

export const runtime = {
  currentTaskId: null,
  clarificationPlan: null,
  clarificationRounds: [],
  activeQuestionnaire: [],
  questionIndex: 0,
  answers: {},
  customAnswers: {},
  finalizedRequirement: "",
  questionnaireLoading: false,
  questionnaireFullyLoaded: false,
  finalizeInProgress: false,
  progressiveAppendTimer: null,
  backgroundElicitationStop: false,
  finalizeDebounceTimer: null,
  backgroundFinalizeRunning: false,
  backgroundFinalizePending: false,
  backgroundFinalizeSeq: 0,
  lastFinalizedFingerprint: "",
  lastFinalizedAt: 0,
  finalizeModalOpen: false,
  designSubmitting: false,
  historyRecords: [],
  selectedHistory: null,
  selectedHistoryDetail: null,
  selectedHistoryPreviewKey: "final",
  currentRunId: null,
  currentRunState: null,
  selectedFileId: null,
  isAutoRunning: false,
  tasksSourceRuns: [],
  selectedTasksSourceRunId: null,
  recentEventLastAt: "",
  recentEventCursor: 0,
  sddHeartbeatTimer: null,
  lastSddGateLogKey: "",
  isGeneratingBase: false,
  isGeneratingSdd: false,
  refreshInFlight: false,
  refreshQueued: false,
  refreshDebounceTimer: null,
  filePreviewDirty: false,
  recentPrintedEventKeys: new Set(),
  wsClient: null,
  elicitationResolve: null,
  chatMessages: [],
};

const stateStore = window.JapAppState || null;

export function updateAppState(partial) {
  if (stateStore) stateStore.updateState(partial);
}

export function esc(input) {
  return String(input).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function normalizeAnswersForApi() {
  const out = {};
  const allKeys = new Set([...Object.keys(runtime.answers), ...Object.keys(runtime.customAnswers)]);
  allKeys.forEach((k) => {
    const aiAns = runtime.answers[k];
    const custAns = runtime.customAnswers[k] || [];
    if (Array.isArray(aiAns)) {
      out[k] = [...aiAns, ...custAns];
    } else {
      const base = aiAns !== undefined ? String(aiAns) : "";
      out[k] = custAns.length > 0 ? (base ? `${base}。补充：${custAns.join("；")}` : custAns.join("；")) : base;
    }
  });
  return out;
}

export function buildAnswersFingerprint() {
  const normalized = normalizeAnswersForApi();
  const keys = Object.keys(normalized).sort();
  const parts = keys.map((k) => {
    const v = normalized[k];
    if (Array.isArray(v)) return `${k}:${[...v].sort().join("|")}`;
    return `${k}:${String(v)}`;
  });
  return parts.join(";");
}

export function getFlattenQuestionnaire() {
  const list = [];
  runtime.clarificationRounds.forEach((r) => { (r.questions || []).forEach((q) => list.push(q)); });
  return list;
}

export function getSessionLlmConfig() {
  try {
    const raw = sessionStorage.getItem(SESSION_LLM_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSessionLlmConfig(config) {
  if (config?.apiKey) sessionStorage.setItem(SESSION_LLM_CONFIG_KEY, JSON.stringify(config));
}

export function getElicitationMode() {
  const mode = sessionStorage.getItem(SESSION_ELICITATION_MODE_KEY);
  return mode === "deep" ? "deep" : "quick";
}

export function setElicitationMode(mode) {
  sessionStorage.setItem(SESSION_ELICITATION_MODE_KEY, mode === "deep" ? "deep" : "quick");
}

export function getWorkflowMode() {
  return "filewise";
}

export function setWorkflowMode(mode) {
  localStorage.setItem(LOCAL_WORKFLOW_MODE_KEY, mode === "legacy" ? "legacy" : "filewise");
}

export function getWorkspacePathConfig() {
  const p = localStorage.getItem(LOCAL_WORKSPACE_PATH_KEY);
  return p ? { path: p } : null;
}

export function setWorkspacePathConfig(path) {
  if (!path) {
    localStorage.removeItem(LOCAL_WORKSPACE_PATH_KEY);
    return;
  }
  localStorage.setItem(LOCAL_WORKSPACE_PATH_KEY, path);
}

export function getShowIntermediateArtifacts() {
  const v = localStorage.getItem(LOCAL_SHOW_INTERMEDIATE_ARTIFACTS_KEY);
  return v === null ? true : v === "1";
}

export function setShowIntermediateArtifacts(enabled) {
  localStorage.setItem(LOCAL_SHOW_INTERMEDIATE_ARTIFACTS_KEY, enabled ? "1" : "0");
}

export function updateLlmChip(ok) {
  const el = document.getElementById("llmChip");
  el.className = `chip ${ok ? "green" : "red"}`;
  el.textContent = ok ? "LLM: configured" : "LLM: not configured";
}

export function updateWsChip(status) {
  const el = document.getElementById("wsChip");
  el.className = `chip ${status === "connected" ? "green" : status === "disconnected" ? "red" : ""}`;
  el.textContent = `WebSocket: ${status}`;
}

export function hasAvailableLlmConfig() {
  const key = (document.getElementById("llmApiKey").value || "").trim();
  if (key) return true;
  const cached = getSessionLlmConfig();
  return Boolean((cached?.apiKey || "").trim());
}

export function canStartDesign() {
  const inputEl = document.getElementById("chatInput");
  const baseRequirement = (runtime.finalizedRequirement || "").trim() || (inputEl ? inputEl.value : "").trim() || runtime.chatMessages.length > 0;
  return Boolean(baseRequirement) && !runtime.finalizeInProgress && !runtime.finalizeModalOpen && !runtime.designSubmitting && hasAvailableLlmConfig();
}

export function refreshDesignButtonState() {
  const btn = document.getElementById("designBtn");
  const enabled = canStartDesign();
  btn.disabled = !enabled;
  btn.className = `btn ${enabled ? "btn-primary" : "btn-light"}`;
}

export function setTaskIdentity(taskId, sourceId) {
  document.getElementById("currentTaskId").textContent = taskId || "--";
  document.getElementById("sourceTaskId").textContent = sourceId || "--";
  updateAppState({ taskId: taskId || null });
}
