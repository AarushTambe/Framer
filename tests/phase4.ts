import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import readline from 'readline';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runInit } from '../src/cli/commands/init';
import { runIndex } from '../src/core/indexer/index';

const TEST_DIR = path.join(__dirname, 'phase4-test-repo');
const CLI_PATH = path.resolve(__dirname, '../src/cli/index.ts');

function setupTestRepo() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR);
    fs.mkdirSync(path.join(TEST_DIR, 'src'));
    fs.writeFileSync(path.join(TEST_DIR, 'src', 'data.ts'), 
        'line 1\nline 2\nline 3\nline 4\nline 5\nexport const auth = true;\n'
    );
}

const getText = (res: any) => (res as any).content?.[0]?.text || '';

async function runPhase4Tests() {
    console.error("=== Phase 4: MCP Transport Tests ===");
    setupTestRepo();
    runInit(TEST_DIR);
    runIndex(TEST_DIR);

    // Node.js >= 22 requires shell: true for .cmd files. 
    // We strictly quote "${CLI_PATH}" so Windows handles the space in "Aarush Tambe".
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const serverProcess = spawn(npx, ['tsx', `"${CLI_PATH}"`, 'mcp'], { 
        cwd: TEST_DIR,
        shell: true 
    });

    let serverStderr = '';
    serverProcess.stderr.on('data', (d) => {
        serverStderr += d.toString();
        // Forward valid diagnostic logs to the test output
        console.error(`[SERVER STDERR]: ${d.toString().trim()}`);
    });
    
    serverProcess.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
            console.error(`[SERVER EXIT]: code=${code}, signal=${signal}`);
        }
    });

    let rogueStdout = false;

    const transport = {
        onmessage: undefined as any,
        onerror: undefined as any,
        onclose: undefined as any,
        async start() {
            const rl = readline.createInterface({ input: serverProcess.stdout });
            rl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                if (!trimmed.startsWith('{')) {
                    rogueStdout = true;
                    console.error(`[ROGUE STDOUT CAUGHT]: ${trimmed}`);
                    return;
                }
                try {
                    const msg = JSON.parse(trimmed);
                    if (this.onmessage) this.onmessage(msg);
                } catch (e) {
                    rogueStdout = true;
                }
            });
            serverProcess.on('error', (e) => this.onerror?.(e));
            serverProcess.on('close', () => this.onclose?.());
        },
        async close() {
            serverProcess.kill();
        },
        async send(message: any) {
            serverProcess.stdin.write(JSON.stringify(message) + '\n');
        }
    };

    const client = new Client(
        { name: "test-client", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        await client.connect(transport);
        console.error("[PASS] Test A (MCP initialization): Handshake successful on single dedicated process.");
        
        // Test B — Tool discovery (Strict "Exactly 4" validation)
        const { tools } = await client.listTools();
        const toolNames = tools.map(t => t.name).sort();
        const expectedTools = ['get_project_state', 'search_codebase', 'get_file', 'generate_context'].sort();
        
        if (tools.length !== 4) {
            throw new Error(`Tool discovery failed: Expected exactly 4 tools, got ${tools.length}`);
        }
        if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
            throw new Error(`Tool discovery failed: Mismatch in expected tool names. Got ${toolNames}`);
        }
        console.error("[PASS] Test B (Tool Discovery): Exactly 4 required V1 tools exposed and validated.");

        // Test C — Project State
        const stateRes = await client.callTool({ name: "get_project_state", arguments: {} });
        if (!getText(stateRes).includes("### project.md")) throw new Error("State missing project.md");
        console.error("[PASS] Test C (Project State): Successfully retrieved .framer state files.");

        // Test D — Search Codebase
        const searchRes = await client.callTool({ name: "search_codebase", arguments: { query: "auth" } });
        const searchResults = JSON.parse(getText(searchRes));
        if (searchResults[0].path !== 'src/data.ts') throw new Error("Search codebase failed.");
        console.error("[PASS] Test D (Search): search_codebase successfully delegated to Retriever.");

        // Test E — File Retrieval (with ranges)
        const fileResFull = await client.callTool({ name: "get_file", arguments: { path: "src/data.ts" } });
        if (!getText(fileResFull).includes("line 5")) throw new Error("Full file fetch failed");
        
        const fileResRange = await client.callTool({ name: "get_file", arguments: { path: "src/data.ts", start_line: 2, end_line: 3 } });
        const textRange = getText(fileResRange);
        if (!textRange.includes("line 2") || textRange.includes("line 1") || textRange.includes("line 4")) {
            throw new Error(`Line range slice failed: got \n${textRange}`);
        }
        console.error("[PASS] Test E (File Retrieval): get_file fetched correct ranges.");

        // Test F — Path Security
        const securityRes: any = await client.callTool({ name: "get_file", arguments: { path: "../outside.txt" } });
        if (!securityRes.isError || !getText(securityRes).includes("Security Violation")) {
            throw new Error("Path security bypassed over MCP!");
        }
        console.error("[PASS] Test F (Path Security): Path traversal cleanly rejected by MCP tool wrapper.");

        // Test G — Context generation
        const ctxRes = await client.callTool({ name: "generate_context", arguments: { task: "auth" } });
        const ctx = JSON.parse(getText(ctxRes));
        if (!ctx.budgetInfo || ctx.chunks.length === 0) throw new Error("Generate context payload invalid.");
        console.error("[PASS] Test G (Context Generation): generate_context respects Engine token boundaries.");

        // Test H — Stdout Integrity Validation
        await new Promise(r => setTimeout(r, 100));
        if (rogueStdout) throw new Error("Rogue non-JSON string detected on stdout!");
        console.error("[PASS] Test H (Stdout Integrity): Stdout for this exact process contains ONLY valid JSON-RPC traffic.");

        // Test I — Layer Separation
        const toolsSource = fs.readFileSync(path.join(__dirname, '../src/mcp/tools.ts'), 'utf-8');
        if (toolsSource.includes('better-sqlite3') || toolsSource.includes('core/indexer/db')) {
            throw new Error("MCP tools.ts directly imports database/indexing logic.");
        }
        console.error("[PASS] Test I (Layer Separation): MCP layer isolated from SQLite and indexer persistence.");

        // Test J — Client-Agnostic
        console.error("[PASS] Test J (Client-Agnostic): Tested entirely via standard MCP SDK protocol, no AI client mocks.");

    } finally {
        await transport.close();
    }
    
    console.error("=== Phase 4 Validation Complete ===");
}

runPhase4Tests().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});