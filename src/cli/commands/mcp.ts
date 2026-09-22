import { runMcpServer } from '../../mcp/server';

export function runMcp(repoRoot: string) {
    runMcpServer(repoRoot).catch((err) => {
        console.error("Framer MCP Server crashed:", err);
        process.exit(1);
    });
}