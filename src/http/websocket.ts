import type { Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

import { WS_LOG_TEXT } from "../constants/logTexts.js";
import { setBroadcaster } from "../runtime/workflowEvents.js";

export function registerWorkflowWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  function broadcast(message: string): void {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  setBroadcaster((payload) => {
    broadcast(JSON.stringify(payload));
  });

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "LOG_ADDED",
        data: {
          logType: "INFO",
          title: WS_LOG_TEXT.connectedTitle,
          summary: WS_LOG_TEXT.connectedSummary,
          timestamp: new Date().toISOString(),
        },
      }),
    );
  });

  return wss;
}
