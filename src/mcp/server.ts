// src/mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMcpTools } from "./tools";

export async function runMcpServer(repoRoot: string) {
    const server = new Server(
        { name: "framer-mcp", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    registerMcpTools(server, repoRoot);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    process.stdin.on("close", () => {
        server.close();
        process.exit(0);
    });
}