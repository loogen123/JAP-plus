import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";

import { registerConfigRoutes } from "./http/configRoutes.js";
import { registerTaskRoutes } from "./http/taskRoutes.js";
import { registerElicitationRoutes } from "./http/elicitationRoutes.js";
import { registerWorkflowWebSocket } from "./http/websocket.js";
import { registerRagRoutes } from "./http/ragRoutes.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.resolve(process.cwd(), "public")));
const server = createServer(app);
const wss = registerWorkflowWebSocket(server);

registerTaskRoutes(app, wss);
registerElicitationRoutes(app, wss);
registerConfigRoutes(app);
registerRagRoutes(app);
const port = Number(process.env.PORT || 8080);
server.listen(port, () => {
  console.log(`J-AP Plus web server running at http://localhost:${port}`);
});
