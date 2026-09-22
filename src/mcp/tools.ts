import fs from 'fs';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FTS5Retriever } from '../core/retrieval/fts5';
import { ContextEngine } from '../core/context/engine';
import { validateSafePath } from '../core/repository/paths';
import { getProjectState } from '../core/state/index';

export function registerMcpTools(server: Server, repoRoot: string) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                { 
                    name: "get_project_state", 
                    description: "Returns tracked project documentation", 
                    inputSchema: { type: "object", properties: {} } 
                },
                { 
                    name: "search_codebase", 
                    description: "Locally searches the codebase using FTS5", 
                    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } 
                },
                { 
                    name: "get_file", 
                    description: "Reads file content securely with optional line ranges.", 
                    inputSchema: { 
                        type: "object", 
                        properties: { 
                            path: { type: "string" }, 
                            start_line: { type: "number" }, 
                            end_line: { type: "number" } 
                        }, 
                        required: ["path"] 
                    } 
                },
                { 
                    name: "generate_context", 
                    description: "Builds a budgeted codebase payload.", 
                    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } 
                }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            if (name === "get_project_state") {
                return { content: [{ type: "text", text: getProjectState(repoRoot) }] };
            }
            
            if (name === "search_codebase") {
                const retriever = new FTS5Retriever(repoRoot);
                const results = retriever.search(args?.query as string);
                return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
            }

            if (name === "get_file") {
                const safePath = validateSafePath(repoRoot, args?.path as string);
                let content = fs.readFileSync(safePath, 'utf-8');
                
                if (typeof args?.start_line === 'number' && typeof args?.end_line === 'number') {
                    // Convert 1-indexed to 0-indexed for slice
                    content = content.split('\n').slice(Math.max(0, args.start_line - 1), args.end_line).join('\n');
                }
                return { content: [{ type: "text", text: content }] };
            }

            if (name === "generate_context") {
                const retriever = new FTS5Retriever(repoRoot);
                const engine = new ContextEngine(repoRoot, retriever);
                const ctx = engine.generateContext(args?.task as string);
                return { content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }] };
            }
            
            throw new Error(`Tool not found: ${name}`);
        } catch (err: any) {
            // MCP handles errors gracefully by returning them in the response payload
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
        }
    });
}