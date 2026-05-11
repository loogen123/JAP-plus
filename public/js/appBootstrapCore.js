import { resetDagUI, updateDagNode } from "./dagRenderer.js";
import { addLog, buildSddErrorMessage } from "./eventLog.js";
import { createWsClient } from "./wsClient.js";
import { renderFileTree, updateArtifactActionButtons } from "./artifactViewer.js";
import { mergeQuestions, renderCurrentQuestionView } from "./questionnaire.js";
import { renderHistoryListView, renderHistoryPreviewView, renderHistoryTabsView, renderTasksSourceRunsView } from "./historyPanel.js";
import { fetchHistoryRequirementById, fetchHistoryRequirements, fetchTasksSourceRuns } from "./historyApi.js";
import { confirmGenerateTasksWithSourceAction, continueFromHistoryAction } from "./taskSourceActions.js";
import { wrapWithActiveButtonLock } from "./buttonLocks.js";
import { closeChatModalAction, openChatModalAction, renderChatMessagesAction, sendChatMessageAction, startDesignOnlyAction } from "./chatPanel.js";
import { createModuleSelectionController, filewiseApproveAction, filewiseGenerateBaseNextAction, filewiseGenerateNextAction, filewiseGenerateTasksAction, filewiseRegenerateAction, filewiseRejectAction, filewiseSaveEditAction, toggleAutoRunAction, autoRunLoopAction } from "./filewiseActions.js";
import { createFilewiseCoordinator } from "./filewiseCoordinator.js";
import { chooseHistoryWorkspaceFolderAction, chooseTasksSourceWorkspaceFolderAction, closeHistoryModalAction, closeTasksSourceModalAction, getHistoryWorkspacePathAction, loadHistoryListAction, loadTasksSourceRunsAction, openHistoryModalAction, openTasksSourceModalAction, renderHistoryListAction, renderHistoryPreviewAction, renderHistoryTabsAction, renderTasksSourceRunsAction, selectHistoryAction } from "./historySourceActions.js";
import { buildTaskLlmConfigAction, chooseWorkspaceFolderAction, closeSettingsAction, loadSettingsAction, openSettingsAction, saveSettingsAction, testLlmConnectionAction, validateWorkspaceAction } from "./settingsActions.js";
import { initAppBindings } from "./appBindings.js";
import { API_BASE, STATE_LABEL_MAP, STATE_ORDER, runtime, clone, getFlattenQuestionnaire, getSessionLlmConfig, setSessionLlmConfig, getElicitationMode, setElicitationMode, getWorkspacePathConfig, setWorkspacePathConfig, getShowIntermediateArtifacts, setShowIntermediateArtifacts, updateLlmChip, updateWsChip, refreshDesignButtonState, normalizeAnswersForApi, buildAnswersFingerprint, updateAppState, setTaskIdentity } from "./runtimeStore.js";
import { createWebsocketSetup } from "./websocketSetup.js";
import { createWorkspaceUi } from "./workspaceUi.js";
import { createElicitationFlow } from "./elicitationFlow.js";
import { createFinalizeFlow } from "./finalizeFlow.js";
import { createSettingsCoordinator } from "./settingsCoordinator.js";
import { createChatCoordinator } from "./chatCoordinator.js";
import { createHistoryCoordinator } from "./historyCoordinator.js";
import { createAutoRunCoordinator } from "./autoRunCoordinator.js";
import { createQuestionnaireAnswerCoordinator } from "./questionnaireAnswerCoordinator.js";
resetDagUI();
function getWorkspacePathFromInput() {
  return (document.getElementById("workspacePath").value || "").trim();
}
let refreshFilewiseRunRef = () => {};
let selectPipelineFileRef = () => {};
let handleElicitationResultRef = () => {};
let renderCurrentQuestionRef = () => {};
let closeQuestionnaireModalRef = () => {};
let finishQuestionnaireRef = async () => {};
let updateFileTreeRef = () => {};
const workspaceUi = createWorkspaceUi({
  runtime,
  addLog,
  stateOrder: STATE_ORDER,
  stateLabelMap: STATE_LABEL_MAP,
  updateDagNode,
  renderFileTree,
  updateArtifactActionButtons,
  getShowIntermediateArtifacts,
  getSelectPipelineFile: () => selectPipelineFileRef,
  getRefreshFilewiseRun: () => refreshFilewiseRunRef,
  pullRecentEvents: (...args) => websocket.pullRecentEvents(...args),
});
const websocket = createWebsocketSetup({
  runtime,
  apiBase: API_BASE,
  addLog,
  createWsClient,
  updateWsChip,
  updateAppState,
  getHandleEvent: () => workspaceUi.handleEvent,
  getHandleElicitationResult: () => handleElicitationResultRef,
  getWorkspacePath: getWorkspacePathFromInput,
});
const settings = createSettingsCoordinator({
  apiBase: API_BASE,
  addLog,
  runtime,
  getSessionLlmConfig,
  setSessionLlmConfig,
  getElicitationMode,
  setElicitationMode,
  getShowIntermediateArtifacts,
  setShowIntermediateArtifacts,
  getWorkspacePathConfig,
  setWorkspacePathConfig,
  updateLlmChip,
  refreshDesignButtonState,
  openSettingsAction,
  closeSettingsAction,
  loadSettingsAction,
  saveSettingsAction,
  testLlmConnectionAction,
  chooseWorkspaceFolderAction,
  buildTaskLlmConfigAction,
  validateWorkspaceAction,
  updateFileTree: (files) => updateFileTreeRef(files),
});
const finalizeFlow = createFinalizeFlow({
  runtime,
  apiBase: API_BASE,
  addLog,
  buildTaskLlmConfig: settings.buildTaskLlmConfig,
  getWorkspacePathConfig,
  getFlattenQuestionnaire,
  normalizeAnswersForApi,
  buildAnswersFingerprint,
  refreshDesignButtonState,
  closeQuestionnaireModal: () => closeQuestionnaireModalRef(),
  renderCurrentQuestion: () => renderCurrentQuestionRef(),
});
const elicitationFlow = createElicitationFlow({
  runtime,
  apiBase: API_BASE,
  addLog,
  clone,
  normalizeAnswersForApi,
  mergeQuestions,
  renderCurrentQuestionView,
  buildTaskLlmConfig: settings.buildTaskLlmConfig,
  openSettings: settings.openSettings,
  getElicitationMode,
  getWorkspacePathConfig,
  getOnForceFinish: () => finishQuestionnaireRef,
});
renderCurrentQuestionRef = elicitationFlow.renderCurrentQuestion;
closeQuestionnaireModalRef = elicitationFlow.closeQuestionnaireModal;
finishQuestionnaireRef = finalizeFlow.finishQuestionnaire;
handleElicitationResultRef = elicitationFlow.handleElicitationResult;
function openFileReviewModal() { document.getElementById("fileReviewModal").classList.add("show"); }
function closeFileReviewModal() { document.getElementById("fileReviewModal").classList.remove("show"); }
document.getElementById("filePreview").addEventListener("input", () => {
  runtime.filePreviewDirty = true;
  document.getElementById("btnSaveEdit").disabled = false;
});
const filewise = createFilewiseCoordinator({
  runtime,
  apiBase: API_BASE,
  addLog,
  buildTaskLlmConfig: settings.buildTaskLlmConfig,
  openSettings: settings.openSettings,
  renderWorkflowButtons: workspaceUi.renderWorkflowButtons,
  setTaskIdentity,
  connectWebSocketForTask: websocket.connectWebSocketForTask,
  activateState: workspaceUi.activateState,
  updateFileTree: workspaceUi.updateFileTree,
  closeFileReviewModal,
  openFileReviewModal,
  buildSddErrorMessage,
  pullRecentEvents: websocket.pullRecentEvents,
  startSddHeartbeat: websocket.startSddHeartbeat,
  stopSddHeartbeat: websocket.stopSddHeartbeat,
  updateFileActionButtons: workspaceUi.updateFileActionButtons,
  getWorkspacePath: getWorkspacePathFromInput,
  filewiseGenerateBaseNextAction,
  filewiseGenerateTasksAction,
  filewiseGenerateNextAction,
  filewiseApproveAction,
  filewiseRejectAction,
  filewiseRegenerateAction,
  filewiseSaveEditAction,
});
refreshFilewiseRunRef = filewise.refreshFilewiseRun;
selectPipelineFileRef = filewise.selectPipelineFile;
updateFileTreeRef = workspaceUi.updateFileTree;
const history = createHistoryCoordinator({
  apiBase: API_BASE,
  runtime,
  addLog,
  getWorkspacePathConfig,
  getHistoryWorkspacePath: () => getHistoryWorkspacePathAction({ getWorkspacePathConfig }),
  fetchHistoryRequirements,
  fetchHistoryRequirementById,
  fetchTasksSourceRuns,
  buildTaskLlmConfig: settings.buildTaskLlmConfig,
  openSettings: settings.openSettings,
  setTaskIdentity,
  connectWebSocketForTask: websocket.connectWebSocketForTask,
  refreshFilewiseRun: filewise.refreshFilewiseRun,
  refreshDesignButtonState,
  renderWorkflowButtons: workspaceUi.renderWorkflowButtons,
  stopSddHeartbeat: websocket.stopSddHeartbeat,
  startSddHeartbeat: websocket.startSddHeartbeat,
  buildSddErrorMessage,
  pullRecentEvents: websocket.pullRecentEvents,
  filewiseGenerateTasks: filewise.filewiseGenerateTasks,
  chooseHistoryWorkspaceFolderAction,
  openHistoryModalAction,
  closeHistoryModalAction,
  chooseTasksSourceWorkspaceFolderAction,
  openTasksSourceModalAction,
  closeTasksSourceModalAction,
  renderTasksSourceRunsAction,
  loadTasksSourceRunsAction,
  confirmGenerateTasksWithSourceAction,
  renderHistoryListAction,
  renderHistoryTabsAction,
  renderHistoryPreviewAction,
  loadHistoryListAction,
  selectHistoryAction,
  continueFromHistoryAction,
  renderTasksSourceRunsView,
  renderHistoryListView,
  renderHistoryTabsView,
  renderHistoryPreviewView,
});
const chat = createChatCoordinator({
  apiBase: API_BASE,
  runtime,
  addLog,
  openSettings: settings.openSettings,
  getWorkspacePathConfig,
  refreshDesignButtonState,
  setTaskIdentity,
  connectWebSocketForTask: websocket.connectWebSocketForTask,
  refreshFilewiseRun: filewise.refreshFilewiseRun,
  filewiseGenerateBaseNext: filewise.filewiseGenerateBaseNext,
  openChatModalAction,
  closeChatModalAction,
  renderChatMessagesAction,
  sendChatMessageAction,
  startDesignOnlyAction,
  buildTaskLlmConfig: settings.buildTaskLlmConfig,
});
const moduleSelectionController = createModuleSelectionController();
const promptForModules = moduleSelectionController.promptForModules;
window.confirmModuleSelection = moduleSelectionController.confirmModuleSelection;
async function filewiseApprove() { await filewise.filewiseApprove(promptForModules); }
const autoRun = createAutoRunCoordinator({
  apiBase: API_BASE,
  runtime,
  addLog,
  promptForModules,
  renderWorkflowButtons: workspaceUi.renderWorkflowButtons,
  filewiseGenerateNext: filewise.filewiseGenerateNext,
  filewiseApprove,
  closeFileReviewModal,
  toggleAutoRunAction,
  autoRunLoopAction,
});
const answers = createQuestionnaireAnswerCoordinator({
  runtime,
  finalizeFlow,
  renderCurrentQuestion: elicitationFlow.renderCurrentQuestion,
});
initAppBindings({
  addLog,
  runtime,
  loadSettings: settings.loadSettings,
  setTaskIdentity,
  connectWebSocket: websocket.connectWebSocket,
  activateState: workspaceUi.activateState,
  renderWorkflowButtons: workspaceUi.renderWorkflowButtons,
  refreshDesignButtonState,
  updateLlmChip,
  updateFileActionButtons: workspaceUi.updateFileActionButtons,
  renderChatMessages: chat.renderChatMessages,
  sendChatMessage: chat.sendChatMessage,
  wrapWithActiveButtonLock,
  handlers: {
    openSettings: settings.openSettings,
    closeSettings: settings.closeSettings,
    clearConsole: settings.clearConsole,
    generateQuestionnaire: elicitationFlow.generateQuestionnaire,
    openChatModal: chat.openChatModal,
    closeChatModal: chat.closeChatModal,
    sendChatMessage: chat.sendChatMessage,
    startDesignOnly: chat.startDesignOnly,
    openHistoryModal: history.openHistoryModal,
    closeHistoryModal: history.closeHistoryModal,
    chooseHistoryWorkspaceFolder: history.chooseHistoryWorkspaceFolder,
    loadHistoryList: history.loadHistoryList,
    continueFromHistory: history.continueFromHistory,
    openTasksSourceModal: history.openTasksSourceModal,
    closeTasksSourceModal: history.closeTasksSourceModal,
    chooseTasksSourceWorkspaceFolder: history.chooseTasksSourceWorkspaceFolder,
    loadTasksSourceRuns: history.loadTasksSourceRuns,
    confirmGenerateTasksWithSource: history.confirmGenerateTasksWithSource,
    filewiseGenerateNext: filewise.filewiseGenerateNext,
    toggleAutoRun: autoRun.toggleAutoRun,
    closeFileReviewModal,
    filewiseSaveEdit: filewise.filewiseSaveEdit,
    filewiseRegenerate: filewise.filewiseRegenerate,
    filewiseReject: filewise.filewiseReject,
    filewiseApprove,
    validateWorkspace: settings.validateWorkspace,
    chooseWorkspaceFolder: settings.chooseWorkspaceFolder,
    testLlmConnection: settings.testLlmConnection,
    saveSettings: settings.saveSettings,
    prevQuestion: answers.prevQuestion,
    nextQuestion: answers.nextQuestion,
    finishQuestionnaire: finalizeFlow.finishQuestionnaire,
    regenerateFinalRequirement: finalizeFlow.regenerateFinalRequirement,
    closeFinalizeModal: finalizeFlow.closeFinalizeModal,
    confirmFinalRequirement: finalizeFlow.confirmFinalRequirement,
    filewiseGenerateBaseNext: filewise.filewiseGenerateBaseNext,
    setModalAnswer: answers.setModalAnswer,
    toggleModalAnswer: answers.toggleModalAnswer,
    applyCustomAnswer: answers.applyCustomAnswer,
    removeCustomAnswer: answers.removeCustomAnswer,
  },
});
