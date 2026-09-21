// src/cli/commands/mcp.ts
import { runMcpServer } from '../../mcp/server';

export function runMcp(repoRoot: string) {
    // Crucial: Standard MCP clients read stdout to communicate.
    // If any rogue console.log happens, it breaks the JSON-RPC pipe.
    console.log = console.error;
    
    runMcpServer(repoRoot).catch((err) => {
        console.error("Framer MCP Server crashed:", err);
        process.exit(1);
    });
}