import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PRD_TOOL_CANDIDATES = [
  "generate_prd",
  "create_prd",
  "build_prd",
  "enhance_prd_content",
] as const;

type McpTextBlock = {
  text?: unknown;
  type?: unknown;
};

type McpCallToolResult = {
  content?: unknown;
  data?: unknown;
  isError?: boolean;
  result?: unknown;
};

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

type SequentialThinkingToolHandle = {
  client: Client;
  tool: ListedTool;
};

type McpLogSeverity = "debug" | "warn" | "error";

type McpErrorCode =
  | "MCP_OPTIONAL_SERVER_CONNECT_FAILED"
  | "MCP_REQUIRED_SERVER_CONNECT_FAILED"
  | "MCP_LIST_TOOLS_FAILED"
  | "MCP_CALL_TOOL_FAILED"
  | "MCP_TOOL_NOT_FOUND"
  | "MCP_READ_CONTEXT_FILE_FAILED"
  | "MCP_FIND_SEQUENTIAL_TOOL_FAILED"
  | "MCP_FIND_PRD_TOOL_FAILED";

type McpLogEvent = {
  severity: McpLogSeverity;
  code: McpErrorCode;
  message: string;
  context?: Record<string, unknown>;
  error?: unknown;
};

type SerializedError = {
  name?: string;
  message: string;
  code?: string;
};

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readOwnProperty(value: Record<PropertyKey, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function asToolResult(value: unknown): McpCallToolResult {
  if (!isRecord(value)) {
    return {};
  }
  const out: McpCallToolResult = {
    content: readOwnProperty(value, "content"),
    data: readOwnProperty(value, "data"),
    result: readOwnProperty(value, "result"),
  };
  const isError = readOwnProperty(value, "isError");
  if (typeof isError === "boolean") {
    out.isError = isError;
  }
  return out;
}

function isTextBlock(value: unknown): value is McpTextBlock {
  return Boolean(value) && typeof value === "object";
}

function getTextFromBlock(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isTextBlock(value)) {
    return "";
  }
  return typeof value.text === "string" ? value.text : "";
}

function readFirstTextBlock(result: unknown): string {
  const typed = asToolResult(result);
  if (!Array.isArray(typed.content)) {
    return "";
  }
  return getTextFromBlock(typed.content[0]);
}

function flattenTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => getTextFromBlock(block))
    .join("\n")
    .trim();
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const result: SerializedError = {
      name: error.name,
      message: error.message,
    };
    if (isRecord(error)) {
      const maybeCode = readOwnProperty(error, "code");
      if (typeof maybeCode === "string") {
        result.code = maybeCode;
      }
    }
    return result;
  }
  if (typeof error === "string") {
    return { message: error };
  }
  return { message: "Unknown MCP error" };
}

type ServerConfig = {
  name: string;
  args: string[];
  optional?: boolean;
};

export class JapMcpClient {
  private static sharedClient: JapMcpClient | null = null;
  private static sharedAllowedDir: string | null = null;
  private static projectContextCache = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private clients: {
    name: string;
    client: Client;
    transport: StdioClientTransport;
    toolNames: Set<string>;
  }[] = [];

  constructor() {
    this.client = new Client({
      name: "j-ap-plus-mcp-client",
      version: "0.1.0",
    });
  }

  private logMcpEvent(event: McpLogEvent): void {
    const payload = {
      timestamp: new Date().toISOString(),
      component: "JapMcpClient",
      severity: event.severity,
      code: event.code,
      message: event.message,
      context: event.context,
      error: event.error ? serializeError(event.error) : undefined,
    };
    const line = JSON.stringify(payload);
    if (event.severity === "error") {
      console.error(line);
      return;
    }
    if (event.severity === "warn") {
      console.warn(line);
      return;
    }
    console.info(line);
  }

  static async getSharedClient(allowedDir: string): Promise<JapMcpClient> {
    const normalizedDir = path.resolve(allowedDir);
    if (
      JapMcpClient.sharedClient &&
      JapMcpClient.sharedAllowedDir === normalizedDir &&
      JapMcpClient.sharedClient.isConnected()
    ) {
      return JapMcpClient.sharedClient;
    }
    if (JapMcpClient.sharedClient) {
      await JapMcpClient.sharedClient.close();
    }
    const client = new JapMcpClient();
    await client.connect(normalizedDir);
    JapMcpClient.sharedClient = client;
    JapMcpClient.sharedAllowedDir = normalizedDir;
    return client;
  }

  private isConnected(): boolean {
    return this.clients.length > 0;
  }

  async connect(allowedDir: string): Promise<void> {
    const isWin = process.platform === "win32";
    const npx = isWin ? "npx.cmd" : "npx";

    const serverConfigs: ServerConfig[] = [
      {
        name: "filesystem",
        args: ["-y", "@modelcontextprotocol/server-filesystem", allowedDir],
      },
      {
        name: "sequential-thinking",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      },
      {
        name: "prd-creator",
        args: ["-y", "prd-creator-mcp"],
        optional: true,
      },
    ];

    for (const config of serverConfigs) {
      try {
        const client = new Client({
          name: `jap-client-${config.name}`,
          version: "0.1.0",
        });
        const transport = new StdioClientTransport({
          command: npx,
          args: config.args,
        });
        await client.connect(transport);
        this.clients.push({
          name: config.name,
          client,
          transport,
          toolNames: new Set<string>(),
        });
      } catch (error) {
        if (!config.optional) {
          this.logMcpEvent({
            severity: "error",
            code: "MCP_REQUIRED_SERVER_CONNECT_FAILED",
            message: "Required MCP server failed to connect",
            context: { serverName: config.name },
            error,
          });
          throw error;
        }
        this.logMcpEvent({
          severity: "warn",
          code: "MCP_OPTIONAL_SERVER_CONNECT_FAILED",
          message: "Optional MCP server failed to connect and was skipped",
          context: { serverName: config.name },
          error,
        });
      }
    }

    if (this.clients.length > 0) {
      const firstClient = this.clients[0];
      if (firstClient) {
        this.client = firstClient.client;
        this.transport = firstClient.transport;
      }
    }
  }

  private async callToolAcrossServers(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    for (const holder of this.clients) {
      if (!holder.toolNames.has(name)) {
        try {
          const { tools } = await holder.client.listTools();
          holder.toolNames = new Set(tools.map((t) => t.name));
        } catch (error) {
          this.logMcpEvent({
            severity: "warn",
            code: "MCP_LIST_TOOLS_FAILED",
            message: "Failed to list tools from MCP server",
            context: { serverName: holder.name, requestedTool: name },
            error,
          });
          continue;
        }
      }
      if (holder.toolNames.has(name)) {
        try {
          return asToolResult(await holder.client.callTool({ name, arguments: args }));
        } catch (error) {
          this.logMcpEvent({
            severity: "warn",
            code: "MCP_CALL_TOOL_FAILED",
            message: "Failed to call MCP tool on server",
            context: {
              serverName: holder.name,
              requestedTool: name,
              argumentKeys: Object.keys(args),
            },
            error,
          });
          continue;
        }
      }
    }
    this.logMcpEvent({
      severity: "error",
      code: "MCP_TOOL_NOT_FOUND",
      message: "MCP tool was not found across registered servers",
      context: {
        requestedTool: name,
        connectedServers: this.clients.map((client) => client.name),
      },
    });
    throw new Error(`Tool ${name} not found in any registered MCP server`);
  }

  async writeArtifactsToDisk(
    artifacts: Record<string, string>,
    targetDir: string,
  ): Promise<void> {
    for (const [fileName, content] of Object.entries(artifacts)) {
      const filePath = path.join(targetDir, fileName);
      const result = await this.callToolAcrossServers("write_file", {
        path: filePath,
        content,
      });

      if ("isError" in result && result.isError) {
        throw new Error(`Failed to write artifact via MCP tool: ${fileName}`);
      }
    }
  }

  async readProjectContext(projectRoot: string, ttlMs = 300000): Promise<string> {
    const cacheKey = path.resolve(projectRoot);
    const cached = JapMcpClient.projectContextCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const targetFiles = ["package.json", "README.md", "pom.xml", ".jap-skills.md"];
    const contents: string[] = [];

    for (const file of targetFiles) {
      try {
        const filePath = path.join(projectRoot, file);
        const result = await this.callToolAcrossServers("read_text_file", {
          path: filePath,
        });
        if (!result.isError) {
          const text = readFirstTextBlock(result);
          if (text) {
            contents.push(`--- ${file} ---\n${text}\n`);
          }
        }
      } catch (error) {
        this.logMcpEvent({
          severity: "debug",
          code: "MCP_READ_CONTEXT_FILE_FAILED",
          message: "Failed to read project context file via MCP; continuing",
          context: { fileName: file, projectRoot },
          error,
        });
        continue;
      }
    }
    const value = contents.join("\n");
    JapMcpClient.projectContextCache.set(cacheKey, {
      value,
      expiresAt: now + ttlMs,
    });
    return value;
  }

  async getSequentialThinkingTool(): Promise<SequentialThinkingToolHandle | null> {
    for (const { client } of this.clients) {
      try {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "sequentialthinking");
        if (tool) {
          return { client, tool };
        }
      } catch (error) {
        this.logMcpEvent({
          severity: "warn",
          code: "MCP_FIND_SEQUENTIAL_TOOL_FAILED",
          message: "Failed to inspect MCP server for sequential thinking tool",
          context: { requestedTool: "sequentialthinking" },
          error,
        });
        continue;
      }
    }
    return null;
  }

  async listAvailableTools(): Promise<string[]> {
    const names = new Set<string>();
    for (const holder of this.clients) {
      try {
        const { tools } = await holder.client.listTools();
        tools.forEach((tool) => names.add(tool.name));
      } catch {
        this.logMcpEvent({
          severity: "debug",
          code: "MCP_LIST_TOOLS_FAILED",
          message: "Failed to list tools from MCP server while aggregating names",
          context: { serverName: holder.name },
        });
      }
    }
    return [...names];
  }

  getPrdToolCandidates(): string[] {
    return [...PRD_TOOL_CANDIDATES];
  }

  private async callToolByCandidateNames(
    names: string[],
    args: Record<string, unknown>,
  ): Promise<{ name: string; result: McpCallToolResult } | null> {
    for (const holder of this.clients) {
      try {
        const { tools } = await holder.client.listTools();
        const toolName = names.find((name) => tools.some((t) => t.name === name));
        if (!toolName) {
          continue;
        }
        const result = await holder.client.callTool({
          name: toolName,
          arguments: args,
        });
        return { name: toolName, result: asToolResult(result) };
      } catch (error) {
        this.logMcpEvent({
          severity: "warn",
          code: "MCP_FIND_PRD_TOOL_FAILED",
          message: "Failed while searching or invoking PRD tool candidate",
          context: { candidateNames: names },
          error,
        });
        continue;
      }
    }
    return null;
  }

  async generatePrdDraft(payload: {
    productName: string;
    productDescription: string;
    targetAudience: string;
    coreFeatures: string[];
    constraints?: string[];
    additionalContext?: string;
  }): Promise<{ draft: string; toolName: string } | null> {
    const candidateNames = [...PRD_TOOL_CANDIDATES];
    const called = await this.callToolByCandidateNames(candidateNames, payload);
    if (!called) {
      return null;
    }
    const contentBlocks = called.result?.content;
    let text = flattenTextBlocks(contentBlocks);
    if (!text && typeof called.result?.result === "string") {
      text = String(called.result.result).trim();
    }
    if (!text && typeof called.result?.data === "string") {
      text = String(called.result.data).trim();
    }
    if (!text) {
      return null;
    }
    return {
      draft: text,
      toolName: called.name,
    };
  }

  async callTextToolByCandidates(
    candidateNames: string[],
    payload: Record<string, unknown>,
  ): Promise<{ content: string; toolName: string } | null> {
    const called = await this.callToolByCandidateNames(candidateNames, payload);
    if (!called) {
      return null;
    }
    let text = flattenTextBlocks(called.result?.content);
    if (!text && typeof called.result?.result === "string") {
      text = String(called.result.result).trim();
    }
    if (!text && typeof called.result?.data === "string") {
      text = String(called.result.data).trim();
    }
    if (!text) {
      return null;
    }
    return {
      content: text,
      toolName: called.name,
    };
  }

  async close(): Promise<void> {
    for (const { client } of this.clients) {
      await client.close();
    }
    this.clients = [];
    this.transport = null;
  }
}
