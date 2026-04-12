export const WS_LOG_TEXT = {
  connectedTitle: "WebSocket Connected",
  connectedSummary: "Waiting for task start...",
} as const;

export const TASK_ROUTE_LOG_TEXT = {
  createdTitle: "Task Created",
  createdSummary: "Starting design generation workflow.",
  failedTitle: "Task Failed",
  failedFallbackSummary: "Workflow execution failed.",
  doneTitle: "Task Completed",
  doneSummaryPrefix: "Generated",
  doneSummarySuffix: "deliverable files.",
  errorTitle: "Task Error",
} as const;

export const ELICITATION_NODE_LOG_TEXT = {
  startTitle: "Elicitation Started",
  startSummary: "Generating structured questionnaire.",
  skipTitle: "Elicitation Skipped",
  skipSummary: "Existing questionnaire found; moving to modeling.",
  doneTitle: "Elicitation Completed",
  doneSummary: "Questionnaire generated.",
  doneMockSummary: "Mock questionnaire generated.",
  errorTitle: "Elicitation Failed",
  fallbackSuffix: "; falling back to local questionnaire.",
} as const;

export const MODELING_NODE_LOG_TEXT = {
  startTitle: "Modeling Started",
  startSummary: "Generating core artifacts 01-04.",
  doneTitle: "Modeling Completed",
  doneSummary: "Core artifacts 01-04 generated.",
  doneMockSummary: "Mock artifacts 01-04 generated.",
  fallbackTitle: "Modeling Fallback",
  fallbackSummary: "Switched to JSON parsing fallback mode.",
  errorTitle: "Modeling Failed",
} as const;

export const DETAILING_NODE_LOG_TEXT = {
  startTitle: "Detailing Started",
  startSummary: "Generating detailed artifacts 05-07.",
  doneTitle: "Detailing Completed",
  doneSummary: "Detailed artifacts 05-07 generated.",
  doneMockSummary: "Mock artifacts 05-07 generated.",
  fallbackTitle: "Detailing Fallback",
  fallbackSummary: "Switched to JSON parsing fallback mode.",
  errorTitle: "Detailing Failed",
} as const;

export const REVIEW_NODE_LOG_TEXT = {
  startTitle: "Cross Review Started",
  startSummary: "Running consistency validation across artifacts.",
  passedTitle: "Cross Review Passed",
  passedSummary: "No conflicts found; proceeding to detailing.",
  passedMockSummary: "Mock validation passed; proceeding.",
  failedTitle: "Cross Review Failed",
} as const;

export const WORKFLOW_LOG_TEXT = {
  presentStartTitle: "Delivery Write Started",
  presentStartSummary: "Writing outputs to disk.",
  presentDoneTitle: "Delivery Write Completed",
  presentDoneSummary: "All deliverable files were written.",
  presentErrorTitle: "Delivery Write Failed",
} as const;
