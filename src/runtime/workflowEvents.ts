type BroadcastPayload = {
  type: string;
  data: Record<string, unknown>;
};

type Broadcaster = (payload: BroadcastPayload) => void;

let broadcaster: Broadcaster | null = null;
let currentStage = "STANDBY";
let currentTaskId: string | null = null;

function emit(type: string, data: Record<string, unknown>): void {
  if (!broadcaster) {
    return;
  }
  broadcaster({
    type,
    data: {
      ...data,
      taskId: currentTaskId,
      timestamp: new Date().toISOString(),
    },
  });
}

function emitWithTaskId(taskId: string | null, type: string, data: Record<string, unknown>): void {
  if (!broadcaster) {
    return;
  }
  broadcaster({
    type,
    data: {
      ...data,
      taskId,
      timestamp: new Date().toISOString(),
    },
  });
}

export function setBroadcaster(fn: Broadcaster): void {
  broadcaster = fn;
}

export function beginTask(taskId: string): void {
  currentTaskId = taskId;
  currentStage = "STANDBY";
}

export function endTask(): void {
  currentTaskId = null;
  currentStage = "STANDBY";
}

export function emitStageChanged(to: string): void {
  const from = currentStage;
  currentStage = to;
  emit("STAGE_CHANGED", { from, to });
}

export function emitLogAdded(
  logType: "INFO" | "SUCCESS" | "ERROR",
  title: string,
  summary: string,
): void {
  emit("LOG_ADDED", { logType, title, summary });
}

export function emitTaskFinished(
  status: "DONE" | "ERROR",
  extras: Record<string, unknown> = {},
): void {
  emit("TASK_FINISHED", { status, ...extras });
}

export function emitTaskScopedEvent(
  taskId: string,
  type: string,
  data: Record<string, unknown> = {},
): void {
  emitWithTaskId(taskId, type, data);
}
