// src/cli/commands/setup.ts
import path from 'path';

export function runSetup(repoRoot: string) {
    console.log('To configure your AI client (e.g., Claude Desktop or Cursor), add the following tool/server configuration:\n');
    console.log(JSON.stringify({
        mcpServers: {
            framer: {
                command: "framer",
                args: ["mcp"],
                env: {
                    "cwd": repoRoot
                }
            }
        }
    }, null, 2));
}