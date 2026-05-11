export function createWsClient(options) {
  let ws = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function connect(taskId) {
    if (typeof taskId !== "undefined" && taskId !== null) {
      options.setTaskId(taskId);
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearReconnect();
    clearPing();

    options.onStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      options.onStatus("connected");
      reconnectAttempts = 0;
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    ws.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === "elicitation-result") {
        options.onElicitationResult(payload.payload || payload.data);
        return;
      }
      const eventTaskId = payload?.data?.taskId ?? null;
      if (eventTaskId !== options.getTaskId()) return;
      options.onTaskEvent(payload);
    };

    ws.onerror = () => {
      options.onStatus("disconnected");
    };

    ws.onclose = () => {
      options.onStatus("disconnected");
      clearPing();
      ws = null;

      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts += 1;
        const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
        options.onReconnectInfo(delay, reconnectAttempts, maxReconnectAttempts);
        reconnectTimer = setTimeout(() => connect(options.getTaskId()), delay);
      } else {
        options.onReconnectExhausted();
      }
    };
  }

  function connectForTask(taskId) {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    clearReconnect();
    reconnectAttempts = 0;
    options.setTaskId(taskId || null);
    connect(options.getTaskId());
  }

  function close() {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    clearReconnect();
    clearPing();
  }

  return {
    connect,
    connectForTask,
    close,
  };
}
