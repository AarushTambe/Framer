// src/mcp/tools.ts
import fs from 'fs';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FTS5Retriever } from '../core/retrieval/fts5';
import { generateContext } from '../core/context/engine';
import { validateSafePath } from '../core/repository/paths';
import { getProjectState } from '../core/state';

export function registerMcpTools(server: Server, repoRoot: string) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                { name: "get_project_state", description: "Returns tracked project documentation", inputSchema: { type: "object", properties: {} } },
                { name: "search_codebase", description: "Locally searches the codebase", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
                { name: "get_file", description: "Reads file content safely.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } }, required: ["filePath"] } },
                { name: "generate_context", description: "Builds a budgeted codebase payload.", inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            if (name === "get_project_state") return { content: [{ type: "text", text: getProjectState(repoRoot) }] };
            
            if (name === "search_codebase") {
                const retriever = new FTS5Retriever(repoRoot);
                return { content: [{ type: "text", text: JSON.stringify(retriever.search(args?.query as string, 5), null, 2) }] };
            }

            if (name === "get_file") {
                const safePath = validateSafePath(repoRoot, args?.filePath as string);
                let content = fs.readFileSync(safePath, 'utf-8');
                if (args?.startLine !== undefined && args?.endLine !== undefined) {
                    content = content.split('\n').slice(Math.max(0, (args.startLine as number) - 1), args.endLine as number).join('\n');
                }
                return { content: [{ type: "text", text: content }] };
            }

            if (name === "generate_context") return { content: [{ type: "text", text: generateContext(repoRoot, args?.task as string) }] };
            
            throw new Error(`Tool not found: ${name}`);
        } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    });
}