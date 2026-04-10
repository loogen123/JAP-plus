import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class JapMcpClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;

  constructor() {
    this.client = new Client({
      name: "j-ap-plus-mcp-client",
      version: "0.1.0",
    });
  }

  async connect(allowedDir: string): Promise<void> {
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", allowedDir],
    });

    await this.client.connect(this.transport);
  }

  async writeArtifactsToDisk(
    artifacts: Record<string, string>,
    targetDir: string,
  ): Promise<void> {
    for (const [fileName, content] of Object.entries(artifacts)) {
      const filePath = path.join(targetDir, fileName);
      const result = await this.client.callTool({
        name: "write_file",
        arguments: {
          path: filePath,
          content,
        },
      });

      if ("isError" in result && result.isError) {
        throw new Error(`Failed to write artifact via MCP tool: ${fileName}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.client.close();
    this.transport = null;
  }
}
