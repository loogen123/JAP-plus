import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PRD_TOOL_CANDIDATES = [
  "generate_prd",
  "create_prd",
  "build_prd",
  "enhance_prd_content",
] as const;

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

    const serverConfigs = [
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
        if (!(config as { optional?: boolean }).optional) {
          throw error;
        }
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

  private async callToolAcrossServers(name: string, args: any) {
    for (const holder of this.clients) {
      try {
        if (!holder.toolNames.has(name)) {
          const { tools } = await holder.client.listTools();
          holder.toolNames = new Set(tools.map((t) => t.name));
        }
        if (holder.toolNames.has(name)) {
          return await holder.client.callTool({ name, arguments: args });
        }
      } catch (error) {
        continue;
      }
    }
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
        if (!("isError" in result && result.isError)) {
          const text = (result.content as any)?.[0]?.text;
          if (text) {
            contents.push(`--- ${file} ---\n${text}\n`);
          }
        }
      } catch (error) {
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

  async getSequentialThinkingTool() {
    for (const { client } of this.clients) {
      try {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === "sequentialthinking");
        if (tool) {
          return { client, tool };
        }
      } catch (error) {
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
  ): Promise<{ name: string; result: any } | null> {
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
        return { name: toolName, result };
      } catch {
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
    let text = "";
    if (Array.isArray(contentBlocks)) {
      text = contentBlocks
        .map((block: any) => {
          if (typeof block?.text === "string") {
            return block.text;
          }
          if (typeof block === "string") {
            return block;
          }
          return "";
        })
        .join("\n")
        .trim();
    }
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

  async close(): Promise<void> {
    for (const { client } of this.clients) {
      await client.close();
    }
    this.clients = [];
    this.transport = null;
  }
}
